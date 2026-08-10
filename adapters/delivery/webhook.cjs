'use strict';

const MAX_TIMER_MS = 2_147_483_647;

function createWebhookDelivery({
  url,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5_000,
  headers = {},
  allowInsecureLoopback = false,
} = {}) {
  const endpoint = validateUrl(url, allowInsecureLoopback);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) {
    throw new RangeError(`timeoutMs must be an integer from 1 to ${MAX_TIMER_MS}`);
  }
  const configuredHeaders = normalizeHeaders(headers);

  async function deliver(envelope) {
    validateEnvelope(envelope);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('webhook request timed out')), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          ...configuredHeaders,
          'content-type': 'application/json',
          'idempotency-key': envelope.idempotencyKey,
        },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });
      const httpStatus = Number(response.status);
      const providerReference = response.headers && typeof response.headers.get === 'function'
        ? response.headers.get('x-request-id') || undefined
        : undefined;
      if (httpStatus >= 200 && httpStatus < 300) {
        return { status: 'accepted', httpStatus, providerReference };
      }
      return { status: 'failed', httpStatus, providerReference, code: `http-${httpStatus}` };
    } catch (error) {
      return {
        status: 'ambiguous',
        code: 'request-outcome-unknown',
        detail: safeErrorMessage(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return Object.freeze({ deliver, endpoint });
}

function validateUrl(value, allowInsecureLoopback) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError('url must be a non-empty string');
  const parsed = new URL(value);
  if (parsed.username || parsed.password) throw new RangeError('webhook URL must not contain credentials');
  if (parsed.protocol === 'https:') return parsed.toString();
  if (parsed.protocol !== 'http:') throw new RangeError('webhook URL must use HTTPS');
  const hostname = parsed.hostname.toLowerCase();
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  if (!loopback) throw new RangeError('webhook URL must use HTTPS');
  if (allowInsecureLoopback !== true) {
    throw new RangeError('HTTP loopback webhooks require allowInsecureLoopback=true');
  }
  return parsed.toString();
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new TypeError('headers must be an object');
  }
  const normalized = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (['content-type', 'idempotency-key'].includes(lowerName)) continue;
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(lowerName)) throw new TypeError('webhook header name is invalid');
    const text = String(value);
    if (/[\r\n]/.test(text)) throw new TypeError('webhook header value is invalid');
    normalized[lowerName] = text;
  }
  return normalized;
}

function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new TypeError('delivery envelope must be an object');
  }
  if (typeof envelope.idempotencyKey !== 'string' || envelope.idempotencyKey.trim() === '') {
    throw new TypeError('delivery envelope idempotencyKey must be a non-empty string');
  }
}

function safeErrorMessage(error) {
  return error && typeof error.message === 'string' ? error.message.slice(0, 500) : 'unknown webhook error';
}

module.exports = { createWebhookDelivery };
