'use strict';

function createClientPortal({
  core,
  identity,
  store,
  publicChannels,
  templateId,
  grantIntentTtlMs = 300_000,
  maxCredits = 200,
  staleAfterMs = 5 * 60 * 1000,
  now = Date.now,
} = {}) {
  requireMethod(core, 'execute', 'core');
  requireMethod(core, 'read', 'core');
  requireMethod(identity, 'exchangeCode', 'identity');
  for (const method of [
    'resolveOrCreateRecipient',
    'createSession',
    'authenticateSession',
    'revokeSession',
    'createGrantIntent',
    'getGrantIntent',
    'completeGrantIntent',
    'deleteRecipientIdentity',
  ]) {
    requireMethod(store, method, 'store');
  }
  const resolvedTemplateId = requiredText(templateId, 'templateId');
  const resolvedChannels = normalizePublicChannels(publicChannels, staleAfterMs);
  const broadcasterIds = resolvedChannels.map(channel => channel.broadcasterId);
  const channelById = new Map(resolvedChannels.map(channel => [channel.channelId, channel]));
  const resolvedMaxCredits = boundedInteger(maxCredits, 1, 1_000_000, 'maxCredits');
  const resolvedGrantIntentTtlMs = boundedInteger(
    grantIntentTtlMs,
    1,
    60 * 60 * 1000,
    'grantIntentTtlMs',
  );
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const mutationTails = new Map();

  async function authenticateWechat({ code } = {}) {
    const externalIdentity = await identity.exchangeCode(requiredText(code, 'code'));
    const mapping = await store.resolveOrCreateRecipient(externalIdentity);
    let context = await readContext(mapping.recipientId);
    if (!context) {
      await core.execute({
        kind: 'register-recipient',
        recipientId: mapping.recipientId,
        credits: 0,
        enabled: true,
      });
      context = await readContext(mapping.recipientId);
    }
    if (!context) throw publicPortalError('recipient context unavailable', 503, 'CLIENT_CONTEXT_UNAVAILABLE');
    return store.createSession({ recipientId: mapping.recipientId });
  }

  async function getMe({ token } = {}) {
    const session = await requireSession(token);
    const context = await readContext(session.recipientId);
    if (!context) throw publicPortalError('client context not found', 404, 'CLIENT_CONTEXT_NOT_FOUND');
    return projectMe(context);
  }

  async function getChannels({ token } = {}) {
    const session = await requireSession(token);
    const context = await readContext(session.recipientId);
    if (!context) throw publicPortalError('client context not found', 404, 'CLIENT_CONTEXT_NOT_FOUND');
    const byBroadcaster = new Map(
      Array.isArray(context.channels)
        ? context.channels.map(channel => [channel.broadcasterId, channel])
        : [],
    );
    const currentMs = currentTimeMs(now);
    return resolvedChannels.map(channel => {
      const state = byBroadcaster.get(channel.broadcasterId) || {};
      const observedAt = typeof state.observedAt === 'string' && Number.isFinite(Date.parse(state.observedAt))
        ? new Date(state.observedAt).toISOString()
        : null;
      const ageMs = observedAt === null ? Number.POSITIVE_INFINITY : currentMs - Date.parse(observedAt);
      const stale = !Number.isFinite(ageMs) || ageMs > channel.staleAfterMs || ageMs < -channel.staleAfterMs;
      const knownStatus = ['live', 'offline'].includes(state.status) ? state.status : 'unknown';
      return {
        channelId: channel.channelId,
        name: channel.name,
        ...(channel.sourceLabel ? { sourceLabel: channel.sourceLabel } : {}),
        ...(channel.description ? { description: channel.description } : {}),
        status: stale ? 'unknown' : knownStatus,
        observedAt,
        stale,
      };
    });
  }

  async function logout({ token } = {}) {
    return withSessionMutation(token, async () => {
      await store.revokeSession(token);
      return { loggedOut: true };
    });
  }

  async function deleteAccount({ token } = {}) {
    return withSessionMutation(token, async (session) => {
      for (const channel of resolvedChannels) {
        await core.execute({
          kind: 'subscribe',
          broadcasterId: channel.broadcasterId,
          recipientId: session.recipientId,
          active: false,
        });
      }
      await core.execute({
        kind: 'register-recipient',
        recipientId: session.recipientId,
        enabled: false,
      });
      const deleted = await store.deleteRecipientIdentity({ recipientId: session.recipientId });
      if (!deleted) throw publicPortalError('client identity not found', 404, 'CLIENT_IDENTITY_NOT_FOUND');
      return { deleted: true };
    });
  }

  async function setReminders({ token, enabled } = {}) {
    if (typeof enabled !== 'boolean') throw publicPortalError('enabled must be a boolean', 400, 'INVALID_REQUEST');
    return withSessionMutation(token, async (session) => {
      await core.execute({
        kind: 'register-recipient',
        recipientId: session.recipientId,
        enabled,
      });
      return getMe({ token });
    });
  }

  async function setSubscription({ token, channelId, active } = {}) {
    if (typeof active !== 'boolean') throw publicPortalError('active must be a boolean', 400, 'INVALID_REQUEST');
    const resolvedChannelId = requiredText(channelId, 'channelId');
    const channel = channelById.get(resolvedChannelId);
    if (!channel) throw publicPortalError('public channel not found', 404, 'CHANNEL_NOT_FOUND');
    return withSessionMutation(token, async (session) => {
      await core.execute({
        kind: 'subscribe',
        broadcasterId: channel.broadcasterId,
        recipientId: session.recipientId,
        active,
      });
      return getMe({ token });
    });
  }

  async function createReminderGrant({ token } = {}) {
    return withSessionMutation(token, async (session) => {
      await ensureCreditCapacity(session.recipientId);
      const intent = await store.createGrantIntent({
        recipientId: session.recipientId,
        ttlMs: resolvedGrantIntentTtlMs,
      });
      return {
        intentId: intent.intentId,
        expiresAt: intent.expiresAt,
        templateId: resolvedTemplateId,
      };
    });
  }

  async function completeReminderGrant({ token, intentId, decision } = {}) {
    const resolvedIntentId = requiredText(intentId, 'intentId');
    if (!['accept', 'reject', 'ban'].includes(decision)) {
      throw publicPortalError('decision must be accept, reject, or ban', 400, 'INVALID_REQUEST');
    }
    return withSessionMutation(token, async (session) => {
      const intent = await store.getGrantIntent({
        recipientId: session.recipientId,
        intentId: resolvedIntentId,
      });
      if (intent.status === 'pending' && decision === 'accept') {
        await ensureCreditCapacity(session.recipientId);
      }
      await store.completeGrantIntent({
        recipientId: session.recipientId,
        intentId: resolvedIntentId,
        decision,
      });
      if (decision === 'accept') {
        await core.execute({
          kind: 'grant-credits',
          grantId: resolvedIntentId,
          recipientId: session.recipientId,
          credits: 1,
          availableCreditsCap: resolvedMaxCredits,
        });
      }
      return {
        intentId: resolvedIntentId,
        decision,
        me: await getMe({ token }),
      };
    });
  }

  async function ensureCreditCapacity(recipientId) {
    const context = await readContext(recipientId);
    if (!context) throw publicPortalError('client context not found', 404, 'CLIENT_CONTEXT_NOT_FOUND');
    const entitlement = nonNegativeCount(context.availableCredits) + nonNegativeCount(context.reservedCredits);
    if (!Number.isSafeInteger(entitlement) || entitlement >= resolvedMaxCredits) {
      throw publicPortalError('available reminder credits reached the configured maximum', 409, 'CREDITS_LIMIT_REACHED');
    }
  }

  async function withSessionMutation(token, operation) {
    const initialSession = await requireSession(token);
    return withRecipientMutationLock(initialSession.recipientId, async () => {
      const currentSession = await requireSession(token);
      if (currentSession.recipientId !== initialSession.recipientId) {
        throw publicPortalError('client session identity changed', 401, 'AUTH_REQUIRED');
      }
      return operation(currentSession);
    });
  }

  function withRecipientMutationLock(recipientId, operation) {
    const previous = mutationTails.get(recipientId) || Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    mutationTails.set(recipientId, tail);
    tail.then(() => {
      if (mutationTails.get(recipientId) === tail) mutationTails.delete(recipientId);
    });
    return result;
  }

  async function requireSession(token) {
    const session = await store.authenticateSession(token);
    if (!session) throw publicPortalError('client session is missing or expired', 401, 'AUTH_REQUIRED');
    return session;
  }

  function readContext(recipientId) {
    return core.read({
      kind: 'recipient-context',
      recipientId,
      broadcasterIds,
      deliveryLimit: 50,
    });
  }

  function projectMe(context) {
    const subscriptionsByBroadcaster = new Map(
      Array.isArray(context.subscriptions)
        ? context.subscriptions.map(item => [item.broadcasterId, item])
        : [],
    );
    const channelIdByBroadcaster = new Map(
      resolvedChannels.map(channel => [channel.broadcasterId, channel.channelId]),
    );
    return {
      templateId: resolvedTemplateId,
      reminders: {
        enabled: context.enabled === true,
        availableCredits: nonNegativeCount(context.availableCredits),
        reservedCredits: nonNegativeCount(context.reservedCredits),
      },
      subscriptions: resolvedChannels
        .filter(channel => subscriptionsByBroadcaster.get(channel.broadcasterId)?.active === true)
        .map(channel => channel.channelId),
      activity: (Array.isArray(context.deliveries) ? context.deliveries : [])
        .filter(delivery => channelIdByBroadcaster.has(delivery.broadcasterId))
        .map(delivery => ({
          eventId: delivery.eventId,
          channelId: channelIdByBroadcaster.get(delivery.broadcasterId),
          occurredAt: delivery.occurredAt,
          deliveryStatus: delivery.deliveryStatus,
          handsetDisplayed: 'unverified',
        })),
    };
  }

  return Object.freeze({
    authenticateWechat,
    completeReminderGrant,
    createReminderGrant,
    deleteAccount,
    getChannels,
    getMe,
    logout,
    setReminders,
    setSubscription,
  });
}

function normalizePublicChannels(channels, defaultStaleAfterMs) {
  if (!Array.isArray(channels)) throw new TypeError('publicChannels must be an array');
  const resolvedDefaultStaleAfterMs = boundedInteger(
    defaultStaleAfterMs,
    1,
    365 * 24 * 60 * 60 * 1000,
    'staleAfterMs',
  );
  const channelIds = new Set();
  const broadcasterIds = new Set();
  return Object.freeze(channels.map((channel, index) => {
    if (!channel || typeof channel !== 'object' || Array.isArray(channel)) {
      throw new TypeError(`publicChannels[${index}] must be an object`);
    }
    const channelId = requiredText(channel.channelId, `publicChannels[${index}].channelId`);
    const broadcasterId = requiredText(channel.broadcasterId, `publicChannels[${index}].broadcasterId`);
    if (channelIds.has(channelId) || broadcasterIds.has(broadcasterId)) {
      throw new RangeError('publicChannels channelId and broadcasterId values must be unique');
    }
    channelIds.add(channelId);
    broadcasterIds.add(broadcasterId);
    return Object.freeze({
      channelId,
      broadcasterId,
      name: requiredText(channel.name, `publicChannels[${index}].name`),
      sourceLabel: optionalText(channel.sourceLabel, `publicChannels[${index}].sourceLabel`, 80),
      description: optionalText(channel.description, `publicChannels[${index}].description`, 300),
      staleAfterMs: channel.staleAfterMs === undefined
        ? resolvedDefaultStaleAfterMs
        : boundedInteger(channel.staleAfterMs, 1, 365 * 24 * 60 * 60 * 1000, `publicChannels[${index}].staleAfterMs`),
    });
  }));
}

function optionalText(value, name, maximumLength) {
  if (value === undefined || value === null || value === '') return '';
  const normalized = requiredText(value, name);
  if (normalized.length > maximumLength) throw new RangeError(`${name} must be at most ${maximumLength} characters`);
  return normalized;
}

function requireMethod(value, method, name) {
  if (!value || typeof value[method] !== 'function') {
    throw new TypeError(`${name} must provide ${method}()`);
  }
}

function requiredText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > 500) throw new RangeError(`${name} must be at most 500 characters`);
  return normalized;
}

function boundedInteger(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function nonNegativeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function currentTimeMs(now) {
  const value = Number(now());
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('now must return a non-negative millisecond timestamp');
  return value;
}

function publicPortalError(message, publicStatus, publicCode) {
  const error = new Error(message);
  error.publicStatus = publicStatus;
  error.publicCode = publicCode;
  return error;
}

module.exports = {
  createClientPortal,
};
