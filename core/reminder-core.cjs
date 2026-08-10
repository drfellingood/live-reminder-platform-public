'use strict';

const VALID_STATUSES = new Set(['live', 'offline', 'unknown']);
const FINAL_DELIVERY_STATUSES = new Set(['accepted', 'failed']);
const RESERVED_OBJECT_KEYS = new Set(Object.getOwnPropertyNames(Object.prototype));

function createReminderCore({ store, delivery, clock = Date, policy = {}, readOnly = false } = {}) {
  if (!store || typeof store.transact !== 'function' || typeof store.read !== 'function') {
    throw new TypeError('store must provide transact(callback) and read(callback)');
  }
  if (!delivery || typeof delivery.deliver !== 'function') {
    throw new TypeError('delivery must provide deliver(envelope)');
  }
  if (typeof readOnly !== 'boolean') throw new TypeError('readOnly must be a boolean');

  const settings = Object.freeze({
    creditCost: positiveInteger(policy.creditCost ?? 1, 'policy.creditCost'),
    defaultDeliveryLimit: boundedInteger(policy.defaultDeliveryLimit ?? 100, 1, 1_000, 'policy.defaultDeliveryLimit'),
    maxObservationFutureSkewMs: boundedInteger(
      policy.maxObservationFutureSkewMs ?? 300_000,
      0,
      86_400_000,
      'policy.maxObservationFutureSkewMs',
    ),
  });
  let closed = false;
  let initializationPromise = null;
  let deliveryWorkerRunning = false;

  async function execute(command) {
    ensureOpen();
    if (readOnly) throw publicCommandError('reminder core is read-only', 503, 'READ_ONLY_MODE');
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      throw new TypeError('command must be an object');
    }
    await initialize();

    switch (command.kind) {
      case 'register-recipient':
        return registerRecipient(command);
      case 'grant-credits':
        return grantCredits(command);
      case 'subscribe':
        return subscribe(command);
      case 'observe':
        return observe(command);
      case 'deliver-pending': {
        if (deliveryWorkerRunning) throw new Error('a deliver-pending worker is already running for this core');
        deliveryWorkerRunning = true;
        try {
          return await deliverPending(command);
        } finally {
          deliveryWorkerRunning = false;
        }
      }
      case 'resolve-delivery':
        return resolveDelivery(command);
      default:
        throw new RangeError(`unsupported command kind: ${String(command.kind)}`);
    }
  }

  async function read(query) {
    ensureOpen();
    if (!query || typeof query !== 'object' || Array.isArray(query)) {
      throw new TypeError('query must be an object');
    }
    await initialize();

    switch (query.kind) {
      case 'dashboard':
        return store.read((state) => dashboardView(ensureState(state), nowIso(clock), settings.creditCost));
      case 'event': {
        const eventId = requiredId(query.eventId, 'eventId');
        return store.read((state) => eventView(ensureState(state), eventId));
      }
      case 'recipient': {
        const recipientId = requiredId(query.recipientId, 'recipientId');
        return store.read((state) => recipientView(ensureState(state), recipientId));
      }
      default:
        throw new RangeError(`unsupported query kind: ${String(query.kind)}`);
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (initializationPromise) await initializationPromise;
    if (typeof store.close === 'function') await store.close();
    if (typeof delivery.close === 'function') await delivery.close();
  }

  function ensureOpen() {
    if (closed) throw new Error('reminder core is closed');
  }

  function initialize() {
    if (!initializationPromise) {
      if (readOnly) {
        initializationPromise = store.read((rawState) => {
          ensureState(rawState);
          return { recovered: 0 };
        });
        return initializationPromise;
      }
      const recoveredAt = nowIso(clock);
      initializationPromise = store.transact((rawState) => {
        const state = ensureState(rawState);
        let recovered = 0;
        for (const receipt of Object.values(state.receipts)) {
          if (receipt.deliveryStatus !== 'in-flight') continue;
          receipt.deliveryStatus = 'ambiguous';
          receipt.code = 'process-ended-with-outcome-unknown';
          receipt.evidenceAt = recoveredAt;
          receipt.updatedAt = recoveredAt;
          receipt.handsetDisplayed = 'unverified';
          recovered += 1;
        }
        return { recovered };
      });
    }
    return initializationPromise;
  }

  async function registerRecipient(command) {
    const recipientId = requiredId(command.recipientId, 'recipientId');
    const credits = nonNegativeInteger(command.credits ?? 0, 'credits');
    const enabled = optionalBoolean(command.enabled, true, 'enabled');
    const timestamp = nowIso(clock);

    return store.transact((rawState) => {
      const state = ensureState(rawState);
      const existing = state.recipients[recipientId];
      if (existing) {
        existing.enabled = enabled;
        existing.updatedAt = timestamp;
        return {
          action: 'recipient-updated',
          recipientId,
          availableCredits: existing.availableCredits,
          enabled: existing.enabled,
        };
      }
      state.recipients[recipientId] = {
        recipientId,
        enabled,
        availableCredits: credits,
        grantedCredits: credits,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      return { action: 'recipient-created', recipientId, availableCredits: credits, enabled };
    });
  }

  async function grantCredits(command) {
    const grantId = requiredId(command.grantId, 'grantId');
    const recipientId = requiredId(command.recipientId, 'recipientId');
    const credits = positiveInteger(command.credits, 'credits');
    const timestamp = nowIso(clock);
    return store.transact((rawState) => {
      const state = ensureState(rawState);
      const recipient = state.recipients[recipientId];
      if (!recipient) throw new Error(`recipient not found: ${recipientId}`);
      const existing = state.creditGrants[grantId];
      if (existing) {
        if (existing.recipientId !== recipientId || existing.credits !== credits) {
          throw new Error(`grantId conflicts with an existing grant: ${grantId}`);
        }
        return {
          action: 'grant-already-applied',
          grantId,
          recipientId,
          credits,
          availableCredits: recipient.availableCredits,
        };
      }
      const availableCredits = safeIntegerSum(recipient.availableCredits, credits, 'availableCredits');
      const grantedCredits = safeIntegerSum(recipient.grantedCredits, credits, 'grantedCredits');
      recipient.availableCredits = availableCredits;
      recipient.grantedCredits = grantedCredits;
      recipient.updatedAt = timestamp;
      state.creditGrants[grantId] = { grantId, recipientId, credits, appliedAt: timestamp };
      return { action: 'credits-granted', grantId, recipientId, credits, availableCredits: recipient.availableCredits };
    });
  }

  async function subscribe(command) {
    const broadcasterId = requiredId(command.broadcasterId, 'broadcasterId');
    const recipientId = requiredId(command.recipientId, 'recipientId');
    const active = optionalBoolean(command.active, true, 'active');
    const timestamp = nowIso(clock);
    return store.transact((rawState) => {
      const state = ensureState(rawState);
      if (!state.recipients[recipientId]) throw new Error(`recipient not found: ${recipientId}`);
      const key = subscriptionKey(broadcasterId, recipientId);
      state.subscriptions[key] = {
        broadcasterId,
        recipientId,
        active,
        updatedAt: timestamp,
      };
      return { action: active ? 'subscribed' : 'unsubscribed', broadcasterId, recipientId };
    });
  }

  async function observe(command) {
    const broadcasterId = requiredId(command.broadcasterId, 'broadcasterId');
    const status = String(command.status || '').toLowerCase();
    if (!VALID_STATUSES.has(status)) {
      throw new RangeError('status must be live, offline, or unknown');
    }
    const observedAt = optionalIso(command.observedAt, clock);
    if (Date.parse(observedAt) > Date.parse(nowIso(clock)) + settings.maxObservationFutureSkewMs) {
      throw publicCommandError(
        'observedAt is too far in the future',
        400,
        'OBSERVATION_TIME_IN_FUTURE',
      );
    }
    const observationId = command.observationId === undefined
      ? null
      : requiredId(command.observationId, 'observationId');
    const source = command.source === undefined ? 'unspecified' : requiredId(command.source, 'source');
    const evidence = normalizeEvidence(command.evidence);

    return store.transact((rawState) => {
      const state = ensureState(rawState);
      const broadcaster = state.broadcasters[broadcasterId] || {
        broadcasterId,
        stableStatus: null,
        lastObservedAt: null,
        lastEventId: null,
        createdAt: observedAt,
      };
      state.broadcasters[broadcasterId] = broadcaster;

      if (observationId) {
        const key = observationKey(broadcasterId, observationId);
        const existingObservation = state.observations[key];
        if (existingObservation) {
          if (existingObservation.status !== status) {
            throw publicCommandError(
              'observationId is already bound to a different status',
              409,
              'OBSERVATION_ID_CONFLICT',
            );
          }
          return {
            action: 'duplicate-observation',
            broadcasterId,
            status,
            eventId: state.observations[key].eventId || null,
          };
        }
      }

      if (status === 'unknown') {
        if (!broadcaster.lastUnknownAt || Date.parse(observedAt) > Date.parse(broadcaster.lastUnknownAt)) {
          broadcaster.lastUnknownAt = observedAt;
        }
        if (observationId) {
          state.observations[observationKey(broadcasterId, observationId)] = {
            broadcasterId,
            observationId,
            status,
            observedAt,
            evidence,
            eventId: null,
          };
        }
        return {
          action: 'ignored-unknown',
          broadcasterId,
          stableStatus: broadcaster.stableStatus,
          eventId: null,
        };
      }

      if (broadcaster.lastObservedAt && Date.parse(observedAt) < Date.parse(broadcaster.lastObservedAt)) {
        if (observationId) {
          state.observations[observationKey(broadcasterId, observationId)] = {
            broadcasterId,
            observationId,
            status,
            observedAt,
            evidence,
            ignoredAsStale: true,
            eventId: null,
          };
        }
        return {
          action: 'ignored-stale',
          broadcasterId,
          stableStatus: broadcaster.stableStatus,
          eventId: null,
        };
      }

      if (broadcaster.stableStatus === status) {
        broadcaster.lastObservedAt = observedAt;
        if (observationId) {
          state.observations[observationKey(broadcasterId, observationId)] = {
            broadcasterId,
            observationId,
            status,
            observedAt,
            evidence,
            eventId: broadcaster.lastEventId,
          };
        }
        return {
          action: 'stable-no-change',
          broadcasterId,
          stableStatus: status,
          eventId: broadcaster.lastEventId,
        };
      }

      const previousStatus = broadcaster.stableStatus;
      broadcaster.stableStatus = status;
      broadcaster.lastObservedAt = observedAt;
      broadcaster.lastSource = source;

      if (status === 'offline') {
        if (observationId) {
          state.observations[observationKey(broadcasterId, observationId)] = {
            broadcasterId,
            observationId,
            status,
            observedAt,
            evidence,
            eventId: null,
          };
        }
        return { action: 'stable-updated', broadcasterId, previousStatus, stableStatus: 'offline', eventId: null };
      }

      const eventId = nextEventId(state, observedAt);
      const eligibleRecipientIds = Object.values(state.subscriptions)
        .filter((subscription) => subscription.broadcasterId === broadcasterId && subscription.active)
        .map((subscription) => state.recipients[subscription.recipientId])
        .filter((recipient) => recipient && recipient.enabled && recipient.availableCredits >= settings.creditCost)
        .map((recipient) => recipient.recipientId)
        .sort();

      const event = {
        eventId,
        broadcasterId,
        previousStatus,
        status: 'live',
        source,
        observationId,
        evidence,
        occurredAt: observedAt,
        createdAt: observedAt,
        eligibleRecipientIds,
        denominator: eligibleRecipientIds.length,
        creditCost: settings.creditCost,
      };
      state.events[eventId] = event;
      broadcaster.lastEventId = eventId;

      for (const recipientId of eligibleRecipientIds) {
        const recipient = state.recipients[recipientId];
        recipient.availableCredits -= settings.creditCost;
        recipient.updatedAt = observedAt;
        const key = receiptKey(eventId, recipientId);
        if (!state.receipts[key]) {
          state.receipts[key] = {
            idempotencyKey: `${eventId}:${recipientId}`,
            eventId,
            broadcasterId,
            recipientId,
            deliveryStatus: 'pending',
            accountingStatus: 'reserved',
            creditCost: settings.creditCost,
            attemptCount: 0,
            createdAt: observedAt,
            updatedAt: observedAt,
            handsetDisplayed: 'unverified',
          };
        }
      }

      if (observationId) {
        state.observations[observationKey(broadcasterId, observationId)] = {
          broadcasterId,
          observationId,
          status,
          observedAt,
          evidence,
          eventId,
        };
      }
      return {
        action: 'event-created',
        broadcasterId,
        previousStatus,
        stableStatus: 'live',
        eventId,
        eligibleRecipientCount: eligibleRecipientIds.length,
      };
    });
  }

  async function deliverPending(command) {
    const limit = boundedInteger(command.limit ?? settings.defaultDeliveryLimit, 1, 1_000, 'limit');
    const counts = { claimed: 0, accepted: 0, failed: 0, ambiguous: 0 };
    while (counts.claimed < limit) {
      const claimedAt = nowIso(clock);
      const envelope = await store.transact((rawState) => {
        const state = ensureState(rawState);
        const receipt = Object.values(state.receipts)
          .filter((item) => item.deliveryStatus === 'pending')
          .sort(compareReceipts)[0];
        if (!receipt) return null;
        const event = state.events[receipt.eventId];
        receipt.deliveryStatus = 'in-flight';
        receipt.attemptCount += 1;
        receipt.attemptStartedAt = claimedAt;
        receipt.updatedAt = claimedAt;
        return {
          idempotencyKey: receipt.idempotencyKey,
          eventId: receipt.eventId,
          broadcasterId: receipt.broadcasterId,
          recipientId: receipt.recipientId,
          occurredAt: event.occurredAt,
          source: event.source,
          attempt: receipt.attemptCount,
        };
      });
      if (!envelope) break;
      counts.claimed += 1;
      let result;
      try {
        result = normalizeDeliveryResult(await delivery.deliver(Object.freeze({ ...envelope })));
      } catch (error) {
        result = {
          status: 'ambiguous',
          code: 'adapter-threw-after-claim',
          detail: safeErrorMessage(error),
        };
      }
      counts[result.status] += 1;
      const settledAt = nowIso(clock);
      await store.transact((rawState) => {
        const state = ensureState(rawState);
        const receipt = state.receipts[receiptKey(envelope.eventId, envelope.recipientId)];
        if (!receipt || receipt.deliveryStatus !== 'in-flight') return;
        settleReceipt(state, receipt, result, settledAt);
      });
    }
    return { action: 'delivery-work-complete', counts };
  }

  async function resolveDelivery(command) {
    const resolutionId = requiredId(command.resolutionId, 'resolutionId');
    const eventId = requiredId(command.eventId, 'eventId');
    const recipientId = requiredId(command.recipientId, 'recipientId');
    const outcome = String(command.outcome || '').toLowerCase();
    const code = command.code === undefined ? null : requiredId(command.code, 'code');
    const providerReference = command.providerReference === undefined
      ? null
      : requiredId(command.providerReference, 'providerReference');
    if (!FINAL_DELIVERY_STATUSES.has(outcome)) {
      throw new RangeError('outcome must be accepted or failed');
    }
    if (!code && !providerReference) {
      throw new TypeError('code or providerReference is required');
    }
    const resolvedAt = nowIso(clock);
    return store.transact((rawState) => {
      const state = ensureState(rawState);
      const existingResolution = state.deliveryResolutions[resolutionId];
      if (existingResolution) {
        const sameResolution = existingResolution.eventId === eventId &&
          existingResolution.recipientId === recipientId &&
          existingResolution.outcome === outcome &&
          existingResolution.code === code &&
          existingResolution.providerReference === providerReference;
        if (!sameResolution) {
          throw publicCommandError(
            'resolutionId is already bound to a different resolution',
            409,
            'RESOLUTION_ID_CONFLICT',
          );
        }
        return {
          action: 'resolution-already-applied',
          resolutionId,
          eventId,
          recipientId,
          deliveryStatus: outcome,
        };
      }
      const receipt = state.receipts[receiptKey(eventId, recipientId)];
      if (!receipt) throw new Error(`receipt not found for event ${eventId} and recipient ${recipientId}`);
      if (FINAL_DELIVERY_STATUSES.has(receipt.deliveryStatus)) {
        return { action: 'already-final', eventId, recipientId, deliveryStatus: receipt.deliveryStatus };
      }
      if (receipt.deliveryStatus !== 'ambiguous') {
        throw new Error(`only ambiguous receipts can be resolved; current status is ${receipt.deliveryStatus}`);
      }
      settleReceipt(state, receipt, {
        status: outcome,
        providerReference: providerReference ?? undefined,
        code: code ?? undefined,
      }, resolvedAt);
      receipt.resolvedManually = true;
      receipt.resolutionId = resolutionId;
      state.deliveryResolutions[resolutionId] = {
        resolutionId,
        eventId,
        recipientId,
        outcome,
        code,
        providerReference,
        resolvedAt,
      };
      return { action: 'resolved', resolutionId, eventId, recipientId, deliveryStatus: outcome };
    });
  }

  return Object.freeze({ execute, read, close });
}

function ensureState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('store state must be an object');
  }
  state.schemaVersion ??= 1;
  if (state.schemaVersion !== 1) throw new Error(`unsupported state schema version: ${state.schemaVersion}`);
  state.nextEventSequence ??= 1;
  state.broadcasters ??= {};
  state.recipients ??= {};
  state.subscriptions ??= {};
  state.events ??= {};
  state.receipts ??= {};
  state.observations ??= {};
  state.creditGrants ??= {};
  state.deliveryResolutions ??= {};
  return state;
}

function createEmptyState() {
  return ensureState({});
}

function settleReceipt(state, receipt, result, timestamp) {
  receipt.deliveryStatus = result.status;
  receipt.updatedAt = timestamp;
  receipt.evidenceAt = timestamp;
  receipt.handsetDisplayed = 'unverified';
  if (result.providerReference !== undefined) receipt.providerReference = String(result.providerReference);
  if (result.code !== undefined) receipt.code = String(result.code);
  if (result.detail !== undefined) receipt.detail = String(result.detail);

  if (result.status === 'accepted') {
    if (receipt.accountingStatus === 'reserved') receipt.accountingStatus = 'consumed';
    receipt.settledAt = timestamp;
    return;
  }
  if (result.status === 'failed') {
    if (receipt.accountingStatus === 'reserved') {
      const recipient = state.recipients[receipt.recipientId];
      if (!recipient) throw new Error(`recipient missing while refunding: ${receipt.recipientId}`);
      recipient.availableCredits += receipt.creditCost;
      recipient.updatedAt = timestamp;
      receipt.accountingStatus = 'refunded';
      receipt.refundedAt = timestamp;
    }
    receipt.settledAt = timestamp;
  }
}

function normalizeDeliveryResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { status: 'ambiguous', code: 'invalid-adapter-result' };
  }
  const status = String(result.status || '').toLowerCase();
  if (!['accepted', 'failed', 'ambiguous'].includes(status)) {
    return { status: 'ambiguous', code: 'invalid-adapter-status' };
  }
  return {
    status,
    providerReference: result.providerReference,
    code: result.code,
    detail: result.detail,
  };
}

function dashboardView(state, generatedAt, creditCost) {
  const receipts = Object.values(state.receipts);
  const events = Object.values(state.events).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const recipients = Object.values(state.recipients)
    .sort((a, b) => a.recipientId.localeCompare(b.recipientId))
    .map((recipient) => recipientView(state, recipient.recipientId));
  return {
    generatedAt,
    semantics: {
      accepted: 'The configured sender accepted the request; handset display remains unverified.',
      ambiguous: 'The request may have started, but no definitive sender outcome is known.',
    },
    summary: {
      broadcasters: Object.keys(state.broadcasters).length,
      recipients: recipients.length,
      events: events.length,
      receipts: receipts.length,
      pending: countStatus(receipts, 'pending'),
      inFlight: countStatus(receipts, 'in-flight'),
      accepted: countStatus(receipts, 'accepted'),
      failed: countStatus(receipts, 'failed'),
      ambiguous: countStatus(receipts, 'ambiguous'),
      bookkeepingPending: receipts.filter(isBookkeepingPending).length,
    },
    broadcasters: Object.values(state.broadcasters)
      .sort((a, b) => a.broadcasterId.localeCompare(b.broadcasterId))
      .map((item) => broadcasterView(state, item, creditCost)),
    recipients,
    events: events.map((event) => ({
      eventId: event.eventId,
      broadcasterId: event.broadcasterId,
      status: event.status,
      source: event.source,
      occurredAt: event.occurredAt,
      denominator: event.denominator,
      counts: receiptCounts(
        receipts.filter((receipt) => receipt.eventId === event.eventId),
        event.denominator,
        event.eligibleRecipientIds,
      ),
    })),
  };
}

function broadcasterView(state, broadcaster, creditCost) {
  const subscriptions = Object.values(state.subscriptions)
    .filter((subscription) => subscription.broadcasterId === broadcaster.broadcasterId && subscription.active);
  return {
    ...broadcaster,
    activeSubscriptions: subscriptions.length,
    currentlyEligibleRecipients: subscriptions
      .map((subscription) => state.recipients[subscription.recipientId])
      .filter((recipient) => recipient && recipient.enabled && recipient.availableCredits >= creditCost)
      .length,
  };
}

function eventView(state, eventId) {
  const event = state.events[eventId];
  if (!event) return null;
  const receipts = Object.values(state.receipts)
    .filter((receipt) => receipt.eventId === eventId)
    .sort((a, b) => a.recipientId.localeCompare(b.recipientId))
    .map((receipt) => ({ ...receipt }));
  return {
    ...event,
    eligibleRecipientIds: [...event.eligibleRecipientIds],
    counts: receiptCounts(receipts, event.denominator, event.eligibleRecipientIds),
    receipts,
  };
}

function recipientView(state, recipientId) {
  const recipient = state.recipients[recipientId];
  if (!recipient) return null;
  const receipts = Object.values(state.receipts).filter((receipt) => receipt.recipientId === recipientId);
  return {
    ...recipient,
    reservedCredits: receipts
      .filter((receipt) => receipt.accountingStatus === 'reserved')
      .reduce((sum, receipt) => sum + receipt.creditCost, 0),
    consumedCredits: receipts
      .filter((receipt) => receipt.accountingStatus === 'consumed')
      .reduce((sum, receipt) => sum + receipt.creditCost, 0),
    refundedCredits: receipts
      .filter((receipt) => receipt.accountingStatus === 'refunded')
      .reduce((sum, receipt) => sum + receipt.creditCost, 0),
  };
}

function receiptCounts(receipts, denominator, eligibleRecipientIds = []) {
  const pending = countStatus(receipts, 'pending');
  const inFlight = countStatus(receipts, 'in-flight');
  const accepted = countStatus(receipts, 'accepted');
  const failed = countStatus(receipts, 'failed');
  const ambiguous = countStatus(receipts, 'ambiguous');
  const bookkeepingPending = receipts.filter(isBookkeepingPending).length;
  const actualRecipientIds = receipts.map((receipt) => receipt.recipientId).sort();
  const expectedRecipientIds = [...eligibleRecipientIds].sort();
  const countConsistent = receipts.length === denominator &&
    new Set(actualRecipientIds).size === actualRecipientIds.length &&
    expectedRecipientIds.length === denominator &&
    actualRecipientIds.every((recipientId, index) => recipientId === expectedRecipientIds[index]);
  const finalAccountingConsistent = receipts.every((receipt) =>
    (receipt.deliveryStatus === 'accepted' && receipt.accountingStatus === 'consumed') ||
    (receipt.deliveryStatus === 'failed' && receipt.accountingStatus === 'refunded') ||
    !FINAL_DELIVERY_STATUSES.has(receipt.deliveryStatus)
  );
  return {
    denominator,
    pending,
    inFlight,
    accepted,
    failed,
    ambiguous,
    bookkeepingPending,
    accounted: receipts.length,
    countConsistent,
    terminal: countConsistent && finalAccountingConsistent && bookkeepingPending === 0 && pending === 0 && inFlight === 0 &&
      ambiguous === 0 && accepted + failed === denominator,
  };
}

function isBookkeepingPending(receipt) {
  return (receipt.deliveryStatus === 'ambiguous' && receipt.accountingStatus === 'reserved') ||
    (receipt.deliveryStatus === 'accepted' && receipt.accountingStatus !== 'consumed') ||
    (receipt.deliveryStatus === 'failed' && receipt.accountingStatus !== 'refunded');
}

function countStatus(receipts, status) {
  return receipts.filter((receipt) => receipt.deliveryStatus === status).length;
}

function publicCommandError(message, publicStatus, publicCode) {
  const error = new Error(message);
  error.publicStatus = publicStatus;
  error.publicCode = publicCode;
  return error;
}

function compareReceipts(left, right) {
  return left.createdAt.localeCompare(right.createdAt) || left.idempotencyKey.localeCompare(right.idempotencyKey);
}

function nextEventId(state, timestamp) {
  const sequence = state.nextEventSequence;
  state.nextEventSequence += 1;
  return `evt_${Date.parse(timestamp).toString(36)}_${sequence.toString(36)}`;
}

function subscriptionKey(broadcasterId, recipientId) {
  return JSON.stringify([broadcasterId, recipientId]);
}

function receiptKey(eventId, recipientId) {
  return JSON.stringify([eventId, recipientId]);
}

function observationKey(broadcasterId, observationId) {
  return JSON.stringify([broadcasterId, observationId]);
}

function requiredId(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > 200) throw new RangeError(`${name} must be at most 200 characters`);
  if (RESERVED_OBJECT_KEYS.has(normalized)) throw new RangeError(`${name} uses a reserved object key`);
  return normalized;
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function boundedInteger(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function optionalBoolean(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
  return value;
}

function safeIntegerSum(left, right, name) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError(`${name} would exceed the safe integer range`);
  return result;
}

function optionalIso(value, clock) {
  if (value === undefined || value === null) return nowIso(clock);
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new RangeError('observedAt must be a valid date');
  return parsed.toISOString();
}

function normalizeEvidence(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('evidence must be a plain object');
  }
  const entries = Object.entries(value);
  if (entries.length > 20) throw new RangeError('evidence may contain at most 20 fields');
  const normalized = {};
  for (const [key, entryValue] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw new RangeError(`evidence field name is not allowed: ${key}`);
    }
    if (entryValue === null || typeof entryValue === 'boolean') {
      normalized[key] = entryValue;
    } else if (typeof entryValue === 'number' && Number.isFinite(entryValue)) {
      normalized[key] = entryValue;
    } else if (typeof entryValue === 'string' && entryValue.length <= 500) {
      normalized[key] = entryValue;
    } else {
      throw new TypeError(`evidence field ${key} must be null, boolean, finite number, or a string up to 500 characters`);
    }
  }
  if (JSON.stringify(normalized).length > 4_096) throw new RangeError('evidence is too large');
  return normalized;
}

function nowIso(clock) {
  const value = typeof clock === 'function' ? clock() : clock.now();
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new RangeError('clock returned an invalid date');
  return parsed.toISOString();
}

function safeErrorMessage(error) {
  return error && typeof error.message === 'string' ? error.message.slice(0, 500) : 'unknown adapter error';
}

module.exports = {
  createReminderCore,
  createEmptyState,
};
