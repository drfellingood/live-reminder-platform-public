'use strict';

const TOKEN_ENDPOINT = 'https://api.weixin.qq.com/cgi-bin/token';
const SEND_ENDPOINT = 'https://api.weixin.qq.com/cgi-bin/message/subscribe/send';
const MAX_TIMER_MS = 2_147_483_647;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const INVALID_TOKEN_CODES = new Set([40001, 40014, 42001]);
const TEMPLATE_SOURCES = new Set([
  'broadcasterId',
  'eventId',
  'occurredAt',
  'source',
]);

function createWechatSubscribeDelivery({
  appId,
  appSecret,
  template,
  resolveOpenId,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5_000,
  clock = Date,
} = {}) {
  const credentials = Object.freeze({
    appId: requiredText(appId, 'appId', 128),
    appSecret: requiredText(appSecret, 'appSecret', 256),
  });
  const messageTemplate = normalizeTemplate(template);
  if (typeof resolveOpenId !== 'function') throw new TypeError('resolveOpenId must be a function');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_MS) {
    throw new RangeError(`timeoutMs must be an integer from 1 to ${MAX_TIMER_MS}`);
  }

  let cachedToken = null;
  let tokenPromise = null;

  async function deliver(envelope) {
    validateEnvelope(envelope);
    if (isDeadlineExpired(envelope, clock)) return deadlineExpiredResult();
    let openId;
    try {
      openId = await resolveOpenId(envelope.recipientId);
    } catch {
      return { status: 'failed', code: 'wechat-recipient-resolution-failed' };
    }
    if (typeof openId !== 'string' || openId.trim() === '') {
      return { status: 'failed', code: 'wechat-recipient-not-found' };
    }
    openId = openId.trim();
    if (isDeadlineExpired(envelope, clock)) return deadlineExpiredResult();

    let accessToken;
    try {
      accessToken = await getAccessToken(envelope.deliveryDeadlineAt);
    } catch (error) {
      if (error && error.code === 'delivery-deadline-expired' || isDeadlineExpired(envelope, clock)) {
        return deadlineExpiredResult();
      }
      return {
        status: 'retryable',
        code: error && error.code || 'wechat-token-unavailable',
        detail: safeDetail(error && error.message, [credentials.appSecret, openId]),
      };
    }

    const body = buildMessageBody(messageTemplate, envelope, openId);
    let providerResult = await sendMessage(
      accessToken,
      body,
      [credentials.appSecret, accessToken, openId],
      envelope.deliveryDeadlineAt,
    );
    if (providerResult.kind === 'response' && INVALID_TOKEN_CODES.has(providerResult.errcode)) {
      cachedToken = null;
      if (isDeadlineExpired(envelope, clock)) return deadlineExpiredResult();
      try {
        accessToken = await getAccessToken(envelope.deliveryDeadlineAt);
      } catch (error) {
        if (error && error.code === 'delivery-deadline-expired' || isDeadlineExpired(envelope, clock)) {
          return deadlineExpiredResult();
        }
        return {
          status: 'retryable',
          code: error && error.code || 'wechat-token-refresh-failed',
          detail: safeDetail(error && error.message, [credentials.appSecret, openId]),
        };
      }
      providerResult = await sendMessage(
        accessToken,
        body,
        [credentials.appSecret, accessToken, openId],
        envelope.deliveryDeadlineAt,
      );
    }
    return normalizeSendResult(providerResult);
  }

  async function getAccessToken(deliveryDeadlineAt) {
    const now = nowMs(clock);
    if (cachedToken && cachedToken.expiresAtMs > now + TOKEN_REFRESH_MARGIN_MS) {
      return cachedToken.value;
    }
    if (tokenPromise) return tokenPromise;
    tokenPromise = fetchAccessToken(now, deliveryDeadlineAt).finally(() => { tokenPromise = null; });
    return tokenPromise;
  }

  async function fetchAccessToken(requestedAtMs, deliveryDeadlineAt) {
    const url = new URL(TOKEN_ENDPOINT);
    url.searchParams.set('grant_type', 'client_credential');
    url.searchParams.set('appid', credentials.appId);
    url.searchParams.set('secret', credentials.appSecret);
    let result;
    try {
      result = await fetchJsonWithTimeout(url, { method: 'GET', redirect: 'error' }, deliveryDeadlineAt);
    } catch {
      throw codedError('WeChat access token request failed', 'wechat-token-unavailable');
    }
    const { response, payload, invalidJson } = result;
    if (!isSuccessfulHttp(response)) {
      throw codedError('WeChat access token endpoint rejected the request', 'wechat-token-http-error');
    }
    if (invalidJson) {
      throw codedError('WeChat access token response was invalid', 'wechat-token-invalid-response');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw codedError('WeChat access token response was invalid', 'wechat-token-invalid-response');
    }
    if (payload.errcode !== undefined && Number(payload.errcode) !== 0) {
      throw codedError('WeChat rejected access token credentials', `wechat-token-errcode-${numericCode(payload.errcode)}`);
    }
    const value = requiredText(payload.access_token, 'access_token', 2_048);
    const expiresInSeconds = Number(payload.expires_in);
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
      throw codedError('WeChat access token expiry was invalid', 'wechat-token-invalid-response');
    }
    cachedToken = {
      value,
      expiresAtMs: requestedAtMs + Math.floor(expiresInSeconds * 1_000),
    };
    return value;
  }

  async function sendMessage(accessToken, body, secrets, deliveryDeadlineAt) {
    const url = new URL(SEND_ENDPOINT);
    url.searchParams.set('access_token', accessToken);
    let result;
    try {
      result = await fetchJsonWithTimeout(url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, deliveryDeadlineAt);
    } catch (error) {
      if (error && error.code === 'delivery-deadline-expired') {
        return { kind: 'deadline-expired' };
      }
      return {
        kind: 'ambiguous',
        code: 'wechat-send-outcome-unknown',
        detail: safeDetail(error && error.message, secrets),
      };
    }
    const { response, payload, invalidJson } = result;
    if (!isSuccessfulHttp(response)) {
      return { kind: 'ambiguous', code: 'wechat-send-http-outcome-unknown' };
    }
    if (invalidJson) {
      return { kind: 'ambiguous', code: 'wechat-send-invalid-response' };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Number.isFinite(Number(payload.errcode))) {
      return { kind: 'ambiguous', code: 'wechat-send-invalid-response' };
    }
    return {
      kind: 'response',
      errcode: Number(payload.errcode),
      errmsg: safeDetail(payload.errmsg, secrets),
      msgid: payload.msgid === undefined ? undefined : String(payload.msgid).slice(0, 200),
    };
  }

  async function fetchJsonWithTimeout(url, options, deliveryDeadlineAt) {
    const remainingMs = Date.parse(deliveryDeadlineAt) - nowMs(clock);
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      throw codedError('Delivery deadline expired before the provider request', 'delivery-deadline-expired');
    }
    const requestTimeoutMs = Math.max(1, Math.min(timeoutMs, Math.ceil(remainingMs)));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('request timed out')), requestTimeoutMs);
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
      try {
        return { response, payload: await response.json(), invalidJson: false };
      } catch {
        return { response, payload: null, invalidJson: true };
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return Object.freeze({ deliver });
}

function normalizeSendResult(result) {
  if (result && result.kind === 'deadline-expired') return deadlineExpiredResult();
  if (!result || result.kind === 'ambiguous') {
    return {
      status: 'ambiguous',
      code: result && result.code || 'wechat-send-outcome-unknown',
      ...(result && result.detail ? { detail: result.detail } : {}),
    };
  }
  if (result.errcode === 0) {
    return {
      status: 'accepted',
      ...(result.msgid ? { providerReference: result.msgid } : {}),
      code: 'wechat-errcode-0',
    };
  }
  return {
    status: 'failed',
    code: `wechat-errcode-${numericCode(result.errcode)}`,
    ...(result.errmsg ? { detail: result.errmsg } : {}),
  };
}

function normalizeTemplate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('template must be an object');
  }
  const id = requiredText(value.id, 'template.id', 256);
  const page = value.page === undefined ? undefined : requiredRelativePage(value.page);
  const state = value.state === undefined ? 'formal' : String(value.state);
  if (!['developer', 'trial', 'formal'].includes(state)) {
    throw new RangeError('template.state must be developer, trial, or formal');
  }
  const language = value.language === undefined ? 'zh_CN' : String(value.language);
  if (!['zh_CN', 'en_US', 'zh_HK', 'zh_TW'].includes(language)) {
    throw new RangeError('template.language is not supported');
  }
  if (!value.fields || typeof value.fields !== 'object' || Array.isArray(value.fields)) {
    throw new TypeError('template.fields must be an object');
  }
  const entries = Object.entries(value.fields);
  if (entries.length < 1 || entries.length > 10) throw new RangeError('template.fields must contain 1 to 10 fields');
  const fields = {};
  for (const [key, definition] of entries) {
    if (!/^[a-z][a-z0-9_]{0,31}$/i.test(key)) throw new RangeError(`template field key is invalid: ${key}`);
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new TypeError(`template field ${key} must be an object`);
    }
    const source = String(definition.source || '');
    if (!TEMPLATE_SOURCES.has(source)) throw new RangeError(`template field ${key} source is not supported`);
    const maxLength = definition.maxLength === undefined ? 100 : definition.maxLength;
    if (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > 200) {
      throw new RangeError(`template field ${key} maxLength must be an integer from 1 to 200`);
    }
    fields[key] = Object.freeze({ source, maxLength });
  }
  return Object.freeze({ id, page, state, language, fields: Object.freeze(fields) });
}

function buildMessageBody(template, envelope, openId) {
  const data = {};
  for (const [key, definition] of Object.entries(template.fields)) {
    data[key] = { value: truncateText(envelope[definition.source], definition.maxLength) };
  }
  return {
    touser: openId,
    template_id: template.id,
    ...(template.page ? { page: template.page } : {}),
    miniprogram_state: template.state,
    lang: template.language,
    data,
  };
}

function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new TypeError('delivery envelope must be an object');
  }
  for (const field of ['idempotencyKey', 'eventId', 'broadcasterId', 'recipientId', 'occurredAt', 'deliveryDeadlineAt']) {
    requiredText(envelope[field], `delivery envelope ${field}`, 500);
  }
  if (!Number.isFinite(Date.parse(envelope.deliveryDeadlineAt))) {
    throw new RangeError('delivery envelope deliveryDeadlineAt must be a valid date');
  }
}

function requiredRelativePage(value) {
  const page = requiredText(value, 'template.page', 256);
  if (page.startsWith('/') || page.includes('..') || /:\/\//.test(page)) {
    throw new RangeError('template.page must be a relative mini-program page');
  }
  return page;
}

function requiredText(value, name, maximumLength) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
  const text = value.trim();
  if (text.length > maximumLength) throw new RangeError(`${name} must be at most ${maximumLength} characters`);
  if (/\r|\n/.test(text)) throw new RangeError(`${name} must be a single line`);
  return text;
}

function truncateText(value, maximumLength) {
  return Array.from(String(value === undefined || value === null ? '' : value)).slice(0, maximumLength).join('');
}

function nowMs(clock) {
  const value = typeof clock === 'function' ? clock() : clock.now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError('clock returned an invalid date');
  return date.getTime();
}

function isSuccessfulHttp(response) {
  return response && Number.isFinite(Number(response.status)) && Number(response.status) >= 200 && Number(response.status) < 300;
}

function numericCode(value) {
  const code = Number(value);
  return Number.isSafeInteger(code) ? code : 'unknown';
}

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isDeadlineExpired(envelope, clock) {
  return nowMs(clock) >= Date.parse(envelope.deliveryDeadlineAt);
}

function deadlineExpiredResult() {
  return {
    status: 'failed',
    code: 'delivery-deadline-expired',
    detail: 'delivery was not attempted after its deadline',
  };
}

function safeDetail(value, secrets = []) {
  let text = typeof value === 'string' ? value.slice(0, 500) : '';
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret !== '') text = text.split(secret).join('[redacted]');
  }
  return text;
}

module.exports = { createWechatSubscribeDelivery };
