'use strict';

const MAX_TIMER_MS = 2_147_483_647;
const MAX_RESPONSE_BYTES = 64 * 1024;

function createHttpJsonStatusSource(options = {}) {
  const id = requireNonEmptyString(options.id, 'id');
  const endpoint = new URL(requireNonEmptyString(options.url, 'url'));
  validateEndpoint(endpoint, options.allowLoopbackHttp === true);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = timerInteger(options.timeoutMs ?? 5_000, 'timeoutMs');
  const bearerToken = options.bearerToken === undefined
    ? null
    : requireBearerToken(options.bearerToken);

  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetch must be a function');
  }

  return Object.freeze({
    id,
    async read() {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), timeoutMs);
      try {
        let response;
        try {
          response = await fetchImpl(endpoint.href, {
            method: 'GET',
            redirect: 'error',
            headers: {
              accept: 'application/json',
              ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
            },
            signal: abortController.signal,
          });
        } catch {
          const reason = abortController.signal.aborted ? 'timeout' : 'network-error';
          return unknownEvidence(endpoint, now, reason);
        }
        if (response.redirected === true
          || (typeof response.url === 'string' && response.url !== '' && response.url !== endpoint.href)) {
          return unknownEvidence(endpoint, now, 'redirect-blocked', { httpStatus: response.status });
        }
        if (!response.ok) {
          return unknownEvidence(endpoint, now, 'http-error', { httpStatus: response.status });
        }
        let payload;
        try {
          payload = await readBoundedJson(response, MAX_RESPONSE_BYTES);
        } catch (error) {
          const reason = abortController.signal.aborted
            ? 'timeout'
            : error && error.code === 'RESPONSE_TOO_LARGE'
              ? 'response-too-large'
              : 'invalid-json';
          return unknownEvidence(endpoint, now, reason, { httpStatus: response.status });
        }
        if (!['live', 'offline', 'unknown'].includes(payload?.status)) {
          return unknownEvidence(endpoint, now, 'invalid-status', { httpStatus: response.status });
        }
        return {
          status: payload.status,
          evidence: {
            kind: 'http-json',
            endpoint: publicEndpoint(endpoint),
            observedAt: toIsoString(now()),
            httpStatus: response.status,
          },
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}

async function readBoundedJson(response, maximumBytes) {
  const declaredLength = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw responseTooLargeError();
  }

  if (response?.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        size += chunk.length;
        if (size > maximumBytes) {
          await reader.cancel().catch(() => {});
          throw responseTooLargeError();
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  }

  if (typeof response?.text !== 'function') throw new TypeError('response body is unavailable');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maximumBytes) throw responseTooLargeError();
  return JSON.parse(text);
}

function responseTooLargeError() {
  return Object.assign(new Error('status response exceeds the size limit'), {
    code: 'RESPONSE_TOO_LARGE',
  });
}

function timerInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new TypeError(`${name} must be an integer from 1 to ${MAX_TIMER_MS}`);
  }
  return value;
}

function unknownEvidence(endpoint, now, reason, extra = {}) {
  return {
    status: 'unknown',
    evidence: {
      kind: 'http-json',
      endpoint: publicEndpoint(endpoint),
      observedAt: toIsoString(now()),
      reason,
      ...extra,
    },
  };
}

function validateEndpoint(url, allowLoopbackHttp) {
  if (url.username || url.password) {
    throw new TypeError('endpoint URL must not contain credentials');
  }
  if (url.protocol === 'https:') {
    return;
  }
  if (url.protocol === 'http:' && allowLoopbackHttp && isLoopbackHost(url.hostname)) {
    return;
  }
  throw new TypeError('endpoint must use HTTPS; loopback HTTP requires explicit opt-in');
}

function isLoopbackHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function requireBearerToken(value) {
  const token = requireNonEmptyString(value, 'bearerToken');
  if (token.length > 4_096 || /[\r\n]/.test(token)) throw new TypeError('bearerToken is invalid');
  return token;
}

function publicEndpoint(url) {
  const copy = new URL(url.href);
  copy.username = '';
  copy.password = '';
  copy.search = '';
  copy.hash = '';
  return copy.href;
}

function toIsoString(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('now must return a valid date');
  }
  return date.toISOString();
}

module.exports = { createHttpJsonStatusSource };
