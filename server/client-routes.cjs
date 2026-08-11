'use strict';

const MAX_CLIENT_BODY_BYTES = 16 * 1024;

function createClientRequestHandler({ portal, readOnly = false } = {}) {
  for (const method of [
    'authenticateWechat',
    'logout',
    'getChannels',
    'getMe',
    'setReminders',
    'setSubscription',
    'createReminderGrant',
    'completeReminderGrant',
    'deleteAccount',
  ]) {
    if (!portal || typeof portal[method] !== 'function') {
      throw new TypeError(`portal must provide ${method}()`);
    }
  }
  if (typeof readOnly !== 'boolean') throw new TypeError('readOnly must be a boolean');

  function handleClientRequest(request, response) {
    let url;
    try {
      url = new URL(request.url || '/', 'http://localhost');
    } catch {
      sendJson(response, 400, { ok: false, error: 'INVALID_REQUEST' });
      return true;
    }
    if (!url.pathname.startsWith('/api/v1/client/')) return false;
    Promise.resolve(dispatch({ request, response, url, portal, readOnly }))
      .catch(error => sendPublicError(response, error));
    return true;
  }

  return handleClientRequest;
}

async function dispatch({ request, response, url, portal, readOnly }) {
  rejectQueryParameters(url);
  rejectRecipientHeader(request);

  if (url.pathname === '/api/v1/client/auth/wechat') {
    requireMethod(request, 'POST');
    requireWritable(readOnly);
    const body = await readStrictJsonBody(request, ['code']);
    const data = await portal.authenticateWechat({ code: body.code });
    return sendJson(response, 201, { ok: true, data });
  }

  if (url.pathname === '/api/v1/client/channels') {
    requireMethod(request, 'GET');
    const data = await portal.getChannels({ token: bearerToken(request) });
    return sendJson(response, 200, { ok: true, data });
  }

  if (url.pathname === '/api/v1/client/session') {
    requireMethod(request, 'DELETE');
    requireWritable(readOnly);
    const data = await portal.logout({ token: bearerToken(request) });
    return sendJson(response, 200, { ok: true, data });
  }

  if (url.pathname === '/api/v1/client/me') {
    if (request.method === 'DELETE') {
      requireWritable(readOnly);
      const data = await portal.deleteAccount({ token: bearerToken(request) });
      return sendJson(response, 200, { ok: true, data });
    }
    requireMethod(request, 'GET');
    const data = await portal.getMe({ token: bearerToken(request) });
    return sendJson(response, 200, { ok: true, data });
  }

  if (url.pathname === '/api/v1/client/me/reminders') {
    requireMethod(request, 'PUT');
    requireWritable(readOnly);
    const body = await readStrictJsonBody(request, ['enabled']);
    const data = await portal.setReminders({
      token: bearerToken(request),
      enabled: body.enabled,
    });
    return sendJson(response, 200, { ok: true, data });
  }

  if (url.pathname === '/api/v1/client/me/reminder-grants') {
    requireMethod(request, 'POST');
    requireWritable(readOnly);
    await readStrictJsonBody(request, []);
    const data = await portal.createReminderGrant({ token: bearerToken(request) });
    return sendJson(response, 201, { ok: true, data });
  }

  const grantCompletionMatch = url.pathname.match(
    /^\/api\/v1\/client\/me\/reminder-grants\/([^/]+)\/complete$/,
  );
  if (grantCompletionMatch) {
    requireMethod(request, 'POST');
    requireWritable(readOnly);
    const body = await readStrictJsonBody(request, ['decision']);
    const data = await portal.completeReminderGrant({
      token: bearerToken(request),
      intentId: decodePathSegment(grantCompletionMatch[1]),
      decision: body.decision,
    });
    return sendJson(response, 200, { ok: true, data });
  }

  const subscriptionMatch = url.pathname.match(/^\/api\/v1\/client\/me\/subscriptions\/([^/]+)$/);
  if (subscriptionMatch) {
    requireMethod(request, 'PUT');
    requireWritable(readOnly);
    const body = await readStrictJsonBody(request, ['active']);
    const data = await portal.setSubscription({
      token: bearerToken(request),
      channelId: decodePathSegment(subscriptionMatch[1]),
      active: body.active,
    });
    return sendJson(response, 200, { ok: true, data });
  }

  return sendJson(response, 404, { ok: false, error: 'CLIENT_ROUTE_NOT_FOUND' });
}

function requireWritable(readOnly) {
  if (readOnly) throw publicRouteError('client writes are disabled', 403, 'READ_ONLY');
}

function requireMethod(request, expected) {
  if (request.method !== expected) {
    throw publicRouteError('method not allowed', 405, 'METHOD_NOT_ALLOWED', { allow: expected });
  }
}

function rejectQueryParameters(url) {
  if ([...url.searchParams].length > 0) {
    throw publicRouteError('query parameters are not accepted', 400, 'INVALID_REQUEST');
  }
}

function rejectRecipientHeader(request) {
  if (request.headers['x-recipient-id'] !== undefined) {
    throw publicRouteError('recipientId must come from the authenticated session', 400, 'RECIPIENT_ID_FORBIDDEN');
  }
}

function bearerToken(request) {
  const match = String(request.headers.authorization || '').match(/^Bearer\s+([^\s]+)$/i);
  return match ? match[1] : undefined;
}

async function readJsonBody(request) {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw publicRouteError('JSON body required', 415, 'JSON_REQUIRED');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_CLIENT_BODY_BYTES) throw publicRouteError('request too large', 413, 'REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw publicRouteError('invalid JSON', 400, 'INVALID_REQUEST');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw publicRouteError('JSON object required', 400, 'INVALID_REQUEST');
  }
  return body;
}

async function readStrictJsonBody(request, fields) {
  const body = await readJsonBody(request);
  rejectRecipientId(body);
  requireExactFields(body, fields);
  return body;
}

function requireExactFields(body, fields) {
  const expected = new Set(fields);
  if (Object.keys(body).length !== expected.size || Object.keys(body).some(field => !expected.has(field))) {
    throw publicRouteError('unexpected request fields', 400, 'INVALID_REQUEST');
  }
}

function rejectRecipientId(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === 'recipientid' || key.toLowerCase() === 'recipient_id') {
      throw publicRouteError('recipientId must come from the authenticated session', 400, 'RECIPIENT_ID_FORBIDDEN');
    }
    rejectRecipientId(child);
  }
}

function decodePathSegment(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw publicRouteError('invalid path parameter', 400, 'INVALID_REQUEST');
  }
  if (decoded.includes('/') || decoded.includes('\\') || decoded.trim() === '') {
    throw publicRouteError('invalid path parameter', 400, 'INVALID_REQUEST');
  }
  return decoded;
}

function sendPublicError(response, error) {
  if (response.headersSent || response.writableEnded) return;
  const status = Number(error && error.publicStatus);
  const statusCode = Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
  const code = statusCode === 500 ? 'INTERNAL_ERROR' : String(error && error.publicCode || 'INVALID_REQUEST');
  const headers = error && error.publicHeaders && typeof error.publicHeaders === 'object'
    ? error.publicHeaders
    : undefined;
  sendJson(response, statusCode, { ok: false, error: code }, headers);
}

function sendJson(response, statusCode, payload, extraHeaders = undefined) {
  if (response.headersSent || response.writableEnded) return;
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...(extraHeaders || {}),
  });
  response.end(body);
}

function publicRouteError(message, publicStatus, publicCode, publicHeaders = undefined) {
  const error = new Error(message);
  error.publicStatus = publicStatus;
  error.publicCode = publicCode;
  if (publicHeaders) error.publicHeaders = publicHeaders;
  return error;
}

module.exports = {
  createClientRequestHandler,
};
