'use strict';

const { randomUUID } = require('node:crypto');
const MAX_TIMER_MS = 2_147_483_647;

function createPollScheduler(options = {}) {
  const broadcasterId = nonEmptyString(options.broadcasterId, 'broadcasterId');
  const statusSource = requireStatusSource(options.statusSource);
  const onObservation = requireFunction(options.onObservation, 'onObservation');
  const pollIntervalMs = timerInteger(options.pollIntervalMs ?? 120_000, 'pollIntervalMs');
  const confirmationIntervalMs = timerInteger(
    options.confirmationIntervalMs ?? 10_000,
    'confirmationIntervalMs',
  );
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => new Date());
  const createCommandId = options.createCommandId ?? randomUUID;
  const setIntervalFn = options.setInterval ?? setInterval;
  const clearIntervalFn = options.clearInterval ?? clearInterval;
  const onError = options.onError ?? (() => {});

  requireFunction(sleep, 'sleep');
  requireFunction(now, 'now');
  requireFunction(createCommandId, 'createCommandId');
  requireFunction(setIntervalFn, 'setInterval');
  requireFunction(clearIntervalFn, 'clearInterval');
  requireFunction(onError, 'onError');

  let intervalHandle;
  let inFlight;
  let liveSubmitted = false;
  let lastSubmittedStatus = null;

  async function submitStatus(status, evidence) {
    const isTransition = lastSubmittedStatus !== status;
    const commandId = isTransition ? nonEmptyString(createCommandId(), 'commandId') : null;
    const observation = {
      broadcasterId,
      status,
      observedAt: isoTimestamp(now()),
      source: statusSource.id,
      evidence: evidence ?? null,
    };
    if (isTransition) {
      observation.observationId = commandId;
      observation.commandId = commandId;
    }
    await onObservation(observation);
    if (!isTransition) return null;
    lastSubmittedStatus = status;
    liveSubmitted = status === 'live';
    return observation;
  }

  async function runCycle() {
    const initial = await safeRead(statusSource);
    if (initial.status === 'offline') {
      liveSubmitted = false;
      const observation = await submitStatus('offline', initial.evidence);
      return { status: 'offline', submitted: observation !== null, observation };
    }
    if (initial.status === 'unknown') {
      liveSubmitted = false;
      const observation = await submitStatus('unknown', initial.evidence);
      return { status: 'unknown', submitted: observation !== null, observation };
    }
    if (liveSubmitted) {
      const observation = await submitStatus('live', initial.evidence);
      return { status: 'live', submitted: observation !== null, observation };
    }

    await sleep(confirmationIntervalMs);
    const confirmation = await safeRead(statusSource);
    if (confirmation.status !== 'live') {
      liveSubmitted = false;
      const observation = await submitStatus(confirmation.status, confirmation.evidence);
      return {
        status: confirmation.status,
        submitted: observation !== null,
        observation,
      };
    }

    const observation = await submitStatus('live', flattenConfirmationEvidence(
      initial.evidence,
      confirmation.evidence,
      confirmationIntervalMs,
    ));
    return { status: 'live', submitted: observation !== null, observation };
  }

  function pollNow() {
    if (inFlight) {
      return inFlight;
    }
    inFlight = runCycle().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  function start() {
    if (intervalHandle !== undefined) {
      return inFlight ?? Promise.resolve({ status: 'running', submitted: false });
    }
    intervalHandle = setIntervalFn(() => {
      pollNow().catch(onError);
    }, pollIntervalMs);
    intervalHandle?.unref?.();
    const firstPoll = pollNow();
    firstPoll.catch(onError);
    return firstPoll;
  }

  function stop() {
    if (intervalHandle !== undefined) {
      clearIntervalFn(intervalHandle);
      intervalHandle = undefined;
    }
  }

  return Object.freeze({ start, stop, pollNow });
}

async function safeRead(statusSource) {
  try {
    const reading = await statusSource.read();
    if (!reading || !['live', 'offline', 'unknown'].includes(reading.status)) {
      return { status: 'unknown', evidence: { reason: 'invalid-source-result' } };
    }
    return reading;
  } catch {
    return { status: 'unknown', evidence: { reason: 'source-error' } };
  }
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requireStatusSource(value) {
  if (!value || typeof value !== 'object') {
    throw new TypeError('statusSource must be an object');
  }
  nonEmptyString(value.id, 'statusSource.id');
  requireFunction(value.read, 'statusSource.read');
  return value;
}

function requireFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function timerInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new TypeError(`${name} must be an integer from 1 to ${MAX_TIMER_MS}`);
  }
  return value;
}

function isoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('now must return a valid date');
  }
  return date.toISOString();
}

function flattenConfirmationEvidence(initial, confirmation, confirmationIntervalMs) {
  return {
    kind: 'confirmed-live',
    confirmationIntervalMs,
    ...prefixPrimitiveEvidence('initial', initial),
    ...prefixPrimitiveEvidence('confirmation', confirmation),
  };
}

function prefixPrimitiveEvidence(prefix, evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return {};
  const result = {};
  for (const [key, value] of Object.entries(evidence).slice(0, 8)) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) continue;
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      result[`${prefix}${key[0].toUpperCase()}${key.slice(1)}`] = value;
    } else if (typeof value === 'string') {
      result[`${prefix}${key[0].toUpperCase()}${key.slice(1)}`] = value.slice(0, 500);
    }
  }
  return result;
}

module.exports = { createPollScheduler };
