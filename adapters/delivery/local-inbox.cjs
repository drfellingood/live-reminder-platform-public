'use strict';

function createLocalInboxDelivery({ clock = Date } = {}) {
  const messages = new Map();

  async function deliver(envelope) {
    validateEnvelope(envelope);
    const existing = messages.get(envelope.idempotencyKey);
    if (existing) {
      return {
        status: 'accepted',
        providerReference: existing.providerReference,
        duplicate: true,
      };
    }
    const providerReference = `local-inbox:${messages.size + 1}`;
    messages.set(envelope.idempotencyKey, {
      ...structuredClone(envelope),
      providerReference,
      acceptedAt: nowIso(clock),
      handsetDisplayed: 'unverified',
    });
    return { status: 'accepted', providerReference, duplicate: false };
  }

  function list({ recipientId } = {}) {
    return [...messages.values()]
      .filter((message) => recipientId === undefined || message.recipientId === recipientId)
      .map((message) => structuredClone(message));
  }

  function clear() {
    messages.clear();
  }

  return Object.freeze({ deliver, list, clear });
}

function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new TypeError('delivery envelope must be an object');
  }
  for (const field of ['idempotencyKey', 'eventId', 'broadcasterId', 'recipientId']) {
    if (typeof envelope[field] !== 'string' || envelope[field].trim() === '') {
      throw new TypeError(`delivery envelope ${field} must be a non-empty string`);
    }
  }
}

function nowIso(clock) {
  const value = typeof clock === 'function' ? clock() : clock.now();
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new RangeError('clock returned an invalid date');
  return parsed.toISOString();
}

module.exports = { createLocalInboxDelivery };
