'use strict';

function createDouyinPageStatusSource(options = {}) {
  const expectedIdentity = String(options.expectedIdentity || '');
  const url = String(options.url || '');
  const canonicalUrl = `https://www.douyin.com/user/${expectedIdentity}`;
  if (!/^[A-Za-z0-9._~-]{1,256}$/.test(expectedIdentity) || url !== canonicalUrl) {
    throw new TypeError('target must be a canonical Douyin profile matching expectedIdentity');
  }
  const driver = options.driver;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const now = options.now ?? (() => new Date());

  return Object.freeze({
    id: options.id,
    async read() {
      let observedAt;
      try {
        observedAt = toIsoString(now());
      } catch {
        return {
          status: 'unknown',
          evidence: {
            kind: 'douyin-page',
            code: 'clock-error',
            observedAt: null,
          },
        };
      }
      let reading;
      try {
        reading = await driver.inspectDouyinPage({ url, expectedIdentity, timeoutMs });
      } catch {
        return {
          status: 'unknown',
          evidence: {
            kind: 'douyin-page',
            code: 'driver-error',
            observedAt,
          },
        };
      }
      if (reading?.verificationRequired === true) {
        return {
          status: 'unknown',
          evidence: {
            kind: 'douyin-page',
            code: 'verification-required',
            observedAt,
            httpStatus: Number.isInteger(reading.httpStatus) ? reading.httpStatus : null,
          },
        };
      }
      if (reading?.httpStatus === 429) {
        return {
          status: 'unknown',
          evidence: {
            kind: 'douyin-page',
            code: 'rate-limited',
            observedAt,
            httpStatus: 429,
          },
        };
      }
      if (Number.isInteger(reading?.httpStatus) && reading.httpStatus !== 200) {
        return {
          status: 'unknown',
          evidence: {
            kind: 'douyin-page',
            code: 'http-error',
            observedAt,
            httpStatus: reading.httpStatus,
          },
        };
      }
      const explicitLive = reading?.httpStatus === 200
        && reading.verificationRequired === false
        && reading.identity === expectedIdentity
        && reading.status === 'live';
      if (explicitLive && !/^[1-9][0-9]{0,39}$/.test(reading.roomId)) {
        return {
          status: 'unknown',
          evidence: {
            kind: 'douyin-page',
            code: 'room-unverified',
            observedAt,
            httpStatus: 200,
            identityMatched: true,
            roomIdValid: false,
          },
        };
      }
      if (
        explicitLive
        && /^[1-9][0-9]{0,39}$/.test(reading.roomId)
      ) {
        return {
          status: 'live',
          evidence: {
            kind: 'douyin-page',
            code: 'explicit-live',
            observedAt,
            httpStatus: 200,
            identityMatched: true,
            roomIdPresent: true,
          },
        };
      }
      if (
        reading?.httpStatus === 200
        && reading.verificationRequired === false
        && typeof reading.identity === 'string'
        && reading.identity !== expectedIdentity
      ) {
        return {
          status: 'unknown',
          evidence: {
            kind: 'douyin-page',
            code: 'identity-mismatch',
            observedAt,
            httpStatus: 200,
            identityMatched: false,
          },
        };
      }
      if (
        reading?.httpStatus === 200
        && reading.verificationRequired === false
        && reading.identity === expectedIdentity
        && reading.status === 'offline'
        && reading.roomId === null
      ) {
        return {
          status: 'offline',
          evidence: {
            kind: 'douyin-page',
            code: 'explicit-offline',
            observedAt,
            httpStatus: 200,
            identityMatched: true,
            roomIdPresent: false,
          },
        };
      }
      if (
        reading?.httpStatus === 200
        && reading.verificationRequired === false
        && reading.identity === expectedIdentity
        && reading.status === 'offline'
        && Object.hasOwn(reading, 'roomId')
        && reading.roomId !== null
      ) {
        return {
          status: 'unknown',
          evidence: {
            kind: 'douyin-page',
            code: 'room-conflict',
            observedAt,
            httpStatus: 200,
            identityMatched: true,
            roomIdPresent: true,
          },
        };
      }
      return {
        status: 'unknown',
        evidence: {
          kind: 'douyin-page',
          code: 'incomplete-observation',
          observedAt,
          httpStatus: Number.isInteger(reading?.httpStatus) ? reading.httpStatus : null,
        },
      };
    },
  });
}

function toIsoString(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('now must produce a valid date');
  return date.toISOString();
}

module.exports = { createDouyinPageStatusSource };
