'use strict';

const DEFAULT_ENDPOINT = 'https://api.weixin.qq.com/sns/jscode2session';
const MAX_TIMER_MS = 2_147_483_647;

function createWechatMiniProgramIdentity({
  appId,
  appSecret,
  fetchImpl = globalThis.fetch,
  endpoint = DEFAULT_ENDPOINT,
  timeoutMs = 5_000,
} = {}) {
  const resolvedAppId = requiredString(appId, 'appId');
  const resolvedAppSecret = requiredString(appSecret, 'appSecret');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_MS) {
    throw new RangeError(`timeoutMs must be an integer from 1 to ${MAX_TIMER_MS}`);
  }
  const resolvedEndpoint = secureEndpoint(endpoint);

  async function exchangeCode(code) {
    const resolvedCode = requiredString(code, 'code');
    const url = new URL(resolvedEndpoint);
    url.searchParams.set('appid', resolvedAppId);
    url.searchParams.set('secret', resolvedAppSecret);
    url.searchParams.set('js_code', resolvedCode);
    url.searchParams.set('grant_type', 'authorization_code');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('request timed out')), timeoutMs);
    let payload;
    try {
      const response = await fetchImpl(url, { redirect: 'error', signal: controller.signal });
      const status = Number(response && response.status);
      if ((Number.isFinite(status) && (status < 200 || status >= 300)) || response && response.ok === false) {
        throw new Error('identity endpoint rejected the request');
      }
      payload = await response.json();
    } catch {
      throw publicIdentityError('WeChat identity is unavailable', 502, 'WECHAT_IDENTITY_UNAVAILABLE');
    } finally {
      clearTimeout(timeout);
    }
    if (Number(payload && payload.errcode) !== 0 && payload && payload.errcode !== undefined) {
      throw publicIdentityError('WeChat did not accept the one-time code', 401, 'WECHAT_CODE_REJECTED');
    }
    if (!payload || typeof payload.openid !== 'string' || payload.openid.trim() === '') {
      throw publicIdentityError('WeChat identity is unavailable', 502, 'WECHAT_IDENTITY_UNAVAILABLE');
    }
    return Object.freeze({
      provider: 'wechat-mini-program',
      subject: payload.openid.trim(),
    });
  }

  return Object.freeze({ exchangeCode });
}

function secureEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('endpoint must be a valid HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new TypeError('endpoint must be a valid HTTPS URL');
  }
  return url.toString();
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function publicIdentityError(message, publicStatus, publicCode) {
  const error = new Error(message);
  error.publicStatus = publicStatus;
  error.publicCode = publicCode;
  return error;
}

module.exports = {
  createWechatMiniProgramIdentity,
};
