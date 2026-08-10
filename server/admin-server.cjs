const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const COOKIE_NAME = 'reminder_admin_session';
const MAX_BODY_BYTES = 64 * 1024;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 5;
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AUTH_STATE_PRUNE_INTERVAL_MS = 60 * 1000;
const MAX_TRACKED_AUTH_KEYS = 10_000;
const SCRYPT_PARAMETERS = Object.freeze({ N: 16_384, r: 8, p: 1, keyLength: 64 });

const SUMMARY_FIELDS = Object.freeze([
  'broadcasters',
  'recipients',
  'events',
  'receipts',
  'pending',
  'inFlight',
  'accepted',
  'failed',
  'ambiguous',
  'bookkeepingPending',
]);
const BROADCASTER_FIELDS = Object.freeze([
  'broadcasterId',
  'stableStatus',
  'lastObservedAt',
  'lastUnknownAt',
  'lastEventId',
  'lastSource',
  'createdAt',
  'updatedAt',
  'activeSubscriptions',
  'currentlyEligibleRecipients',
]);
const EVENT_FIELDS = Object.freeze([
  'eventId',
  'broadcasterId',
  'status',
  'source',
  'occurredAt',
  'denominator',
]);
const EVENT_COUNT_FIELDS = Object.freeze([
  'denominator',
  'pending',
  'inFlight',
  'accepted',
  'failed',
  'ambiguous',
  'bookkeepingPending',
  'accounted',
  'countConsistent',
  'terminal',
]);

function requirePassword(password) {
  if (typeof password !== 'string' || password.length < 12) {
    throw new TypeError('administrator password must contain at least 12 characters');
  }
  if (Buffer.byteLength(password, 'utf8') > 1024) {
    throw new TypeError('administrator password is too long');
  }
  return password;
}

function canonicalBase64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length > 0 && canonicalBase64Url(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function saltBuffer(value) {
  if (value === undefined) return crypto.randomBytes(24);
  const buffer = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value), 'utf8');
  if (buffer.length < 8 || buffer.length > 64) {
    throw new TypeError('scrypt salt must contain between 8 and 64 bytes');
  }
  return buffer;
}

function derivePassword(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT_PARAMETERS.keyLength, {
    N: SCRYPT_PARAMETERS.N,
    r: SCRYPT_PARAMETERS.r,
    p: SCRYPT_PARAMETERS.p,
    maxmem: 64 * 1024 * 1024,
  });
}

function hashAdminPassword(password, salt) {
  const validated = requirePassword(password);
  const resolvedSalt = saltBuffer(salt);
  const digest = derivePassword(validated, resolvedSalt);
  return [
    'scrypt',
    'v1',
    `n=${SCRYPT_PARAMETERS.N}`,
    `r=${SCRYPT_PARAMETERS.r}`,
    `p=${SCRYPT_PARAMETERS.p}`,
    `l=${SCRYPT_PARAMETERS.keyLength}`,
    canonicalBase64Url(resolvedSalt),
    canonicalBase64Url(digest),
  ].join('$');
}

function parsePasswordHash(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 512) return null;
  const parts = encoded.split('$');
  if (parts.length !== 8) return null;
  const [scheme, version, nPart, rPart, pPart, lengthPart, saltText, digestText] = parts;
  if (
    scheme !== 'scrypt' ||
    version !== 'v1' ||
    nPart !== `n=${SCRYPT_PARAMETERS.N}` ||
    rPart !== `r=${SCRYPT_PARAMETERS.r}` ||
    pPart !== `p=${SCRYPT_PARAMETERS.p}` ||
    lengthPart !== `l=${SCRYPT_PARAMETERS.keyLength}`
  ) return null;
  const salt = decodeBase64Url(saltText);
  const digest = decodeBase64Url(digestText);
  if (!salt || salt.length < 8 || salt.length > 64) return null;
  if (!digest || digest.length !== SCRYPT_PARAMETERS.keyLength) return null;
  return { salt, digest };
}

function verifyAdminPassword(password, encoded) {
  let validated;
  try {
    validated = requirePassword(password);
  } catch {
    return false;
  }
  const parsed = parsePasswordHash(encoded);
  if (!parsed) return false;
  try {
    const actual = derivePassword(validated, parsed.salt);
    return crypto.timingSafeEqual(actual, parsed.digest);
  } catch {
    return false;
  }
}

function nowMilliseconds(value = Date.now()) {
  const resolved = typeof value === 'function' ? value() : value;
  const number = resolved instanceof Date ? resolved.getTime() : Number(resolved);
  if (!Number.isFinite(number)) throw new TypeError('clock must return a valid timestamp');
  return Math.trunc(number);
}

function signSessionPayload(payloadText, secret) {
  return crypto.createHmac('sha256', secret).update(payloadText).digest('base64url');
}

function createSessionToken({ sessionId, secret, issuedAt, expiresAt }) {
  const payload = canonicalBase64Url(Buffer.from(JSON.stringify({
    v: 1,
    sid: sessionId,
    iat: issuedAt,
    exp: expiresAt,
  }), 'utf8'));
  return `v1.${payload}.${signSessionPayload(payload, secret)}`;
}

function verifySession(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 1024 || typeof secret !== 'string' || secret.length < 32) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const payloadBuffer = decodeBase64Url(parts[1]);
  const signatureBuffer = decodeBase64Url(parts[2]);
  if (!payloadBuffer || !signatureBuffer || signatureBuffer.length !== 32) return null;
  const expected = Buffer.from(signSessionPayload(parts[1], secret), 'base64url');
  if (!crypto.timingSafeEqual(signatureBuffer, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(payloadBuffer.toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (Object.keys(payload).sort().join(',') !== 'exp,iat,sid,v') return null;
  if (payload.v !== 1 || typeof payload.sid !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(payload.sid)) return null;
  if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)) return null;
  if (payload.exp <= payload.iat || payload.exp - payload.iat > MAX_SESSION_TTL_MS) return null;
  let current;
  try {
    current = nowMilliseconds(now);
  } catch {
    return null;
  }
  if (payload.iat > current + 30_000 || payload.exp <= current) return null;
  return Object.freeze({ sessionId: payload.sid, issuedAt: payload.iat, expiresAt: payload.exp });
}

function positiveInteger(value, fallback, name, maximum = Number.MAX_SAFE_INTEGER) {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

function configFromEnvironment(environment = process.env) {
  return Object.freeze({
    adminPasswordHash: String(environment.ADMIN_PASSWORD_HASH || '').trim(),
    sessionSecret: String(environment.ADMIN_SESSION_SECRET || '').trim(),
    sessionTtlMs: positiveInteger(
      environment.ADMIN_SESSION_TTL_MS,
      DEFAULT_SESSION_TTL_MS,
      'ADMIN_SESSION_TTL_MS',
      MAX_SESSION_TTL_MS,
    ),
    secureCookies: environment.ADMIN_COOKIE_SECURE !== '0',
    trustProxy: environment.ADMIN_TRUST_PROXY === '1',
  });
}

function securityHeaders(contentType) {
  return {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'content-type': contentType,
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  };
}

function sendJson(response, statusCode, value, extraHeaders = {}) {
  if (response.headersSent || response.writableEnded) return;
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    ...securityHeaders('application/json; charset=utf-8'),
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(body);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let exceeded = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        exceeded = true;
        chunks.length = 0;
      } else if (!exceeded) {
        chunks.push(chunk);
      }
    });
    request.on('end', () => {
      if (exceeded) return reject(Object.assign(new Error('request too large'), { code: 'TOO_LARGE' }));
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { code: 'INVALID_JSON' }));
      }
    });
    request.on('error', reject);
  });
}

function cookieToken(request) {
  const entries = String(request.headers.cookie || '').split(';');
  const matches = [];
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    const name = entry.slice(0, separator).trim();
    if (name === COOKIE_NAME) matches.push(entry.slice(separator + 1).trim());
  }
  return matches.length === 1 && matches[0] ? matches[0] : null;
}

function sessionCookie(token, { secureCookies, sessionTtlMs }) {
  const attributes = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(sessionTtlMs / 1000)}`,
  ];
  if (secureCookies) attributes.push('Secure');
  return attributes.join('; ');
}

function clearSessionCookie(secureCookies) {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookies ? '; Secure' : ''}`;
}

function clientAddress(request, trustProxy) {
  if (trustProxy) {
    const first = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (first && first.length <= 128 && /^[0-9A-Fa-f:.]+$/.test(first)) return first;
  }
  return String(request.socket && request.socket.remoteAddress || 'unknown').slice(0, 128);
}

function copyFields(input, fields) {
  const output = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return output;
  for (const field of fields) {
    const value = input[field];
    if (typeof value === 'string' || typeof value === 'boolean' || (Number.isFinite(value) && value >= 0)) {
      output[field] = value;
    } else if (value === null) {
      output[field] = null;
    }
  }
  return output;
}

function projectDashboard(result) {
  const source = result && result.ok === true && result.data ? result.data : result;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('invalid dashboard result');
  return {
    summary: copyFields(source.summary, SUMMARY_FIELDS),
    broadcasters: Array.isArray(source.broadcasters)
      ? source.broadcasters.map((item) => copyFields(item, BROADCASTER_FIELDS))
      : [],
    events: Array.isArray(source.events)
      ? source.events.map((item) => ({
          ...copyFields(item, EVENT_FIELDS),
          counts: copyFields(item && item.counts, EVENT_COUNT_FIELDS),
        }))
      : [],
  };
}

function mimeType(filename) {
  switch (path.extname(filename).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.ico': return 'image/x-icon';
    default: return 'application/octet-stream';
  }
}

function resolveStaticFile(staticDir, requestUrl) {
  const rawPath = String(requestUrl || '/').split('?')[0];
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  let relative;
  if (decoded === '/admin' || decoded === '/admin/') relative = 'index.html';
  else if (decoded.startsWith('/assets/') || decoded === '/favicon.ico') relative = decoded.slice(1);
  else return null;
  const root = path.resolve(staticDir);
  const filename = path.resolve(root, relative);
  if (filename !== root && !filename.startsWith(`${root}${path.sep}`)) return null;
  return filename;
}

function serveStatic(request, response, staticDir) {
  const filename = resolveStaticFile(staticDir, request.url);
  if (!filename) return false;
  let stat;
  try {
    stat = fs.statSync(filename);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const headers = {
    ...securityHeaders(mimeType(filename)),
    'content-length': stat.size,
  };
  response.writeHead(200, headers);
  if (request.method === 'HEAD') response.end();
  else fs.createReadStream(filename).pipe(response);
  return true;
}

function validateHandlerOptions(staticDir, config, loadDashboard) {
  if (typeof staticDir !== 'string' || !staticDir.trim()) throw new Error('staticDir is required');
  if (!config || typeof config !== 'object') throw new Error('admin config is required');
  if (!parsePasswordHash(config.adminPasswordHash)) throw new Error('ADMIN_PASSWORD_HASH is invalid');
  if (typeof config.sessionSecret !== 'string' || config.sessionSecret.length < 32) {
    throw new Error('ADMIN_SESSION_SECRET must contain at least 32 characters');
  }
  positiveInteger(config.sessionTtlMs, DEFAULT_SESSION_TTL_MS, 'sessionTtlMs', MAX_SESSION_TTL_MS);
  if (config.now !== undefined && typeof config.now !== 'function') throw new Error('config.now must be a function');
  if (typeof loadDashboard !== 'function') throw new Error('loadDashboard is required');
}

function createAdminRequestHandler({ staticDir, config, loadDashboard } = {}) {
  validateHandlerOptions(staticDir, config, loadDashboard);
  const sessions = new Map();
  const failures = new Map();
  const sessionTtlMs = positiveInteger(config.sessionTtlMs, DEFAULT_SESSION_TTL_MS, 'sessionTtlMs', MAX_SESSION_TTL_MS);
  const now = config.now || Date.now;
  const secureCookies = config.secureCookies !== false;
  const trustProxy = config.trustProxy === true;
  let nextAuthStatePruneAt = 0;

  function pruneAuthState(current) {
    if (current < nextAuthStatePruneAt) return;
    for (const [sessionId, expiresAt] of sessions) {
      if (expiresAt <= current) sessions.delete(sessionId);
    }
    for (const [address, bucket] of failures) {
      if (bucket.windowEndsAt <= current) failures.delete(address);
    }
    nextAuthStatePruneAt = current + AUTH_STATE_PRUNE_INTERVAL_MS;
  }

  function boundedSet(map, key, value) {
    if (!map.has(key) && map.size >= MAX_TRACKED_AUTH_KEYS) {
      const oldestKey = map.keys().next().value;
      if (oldestKey !== undefined) map.delete(oldestKey);
    }
    map.set(key, value);
  }

  function activeSession(request) {
    const current = nowMilliseconds(now);
    pruneAuthState(current);
    const token = cookieToken(request);
    if (!token) return null;
    const verified = verifySession(token, config.sessionSecret, now);
    if (!verified) return null;
    const storedExpiry = sessions.get(verified.sessionId);
    if (storedExpiry !== verified.expiresAt || storedExpiry <= current) {
      sessions.delete(verified.sessionId);
      return null;
    }
    return verified;
  }

  function failureBucket(address, current) {
    const existing = failures.get(address);
    if (!existing || existing.windowEndsAt <= current) {
      const fresh = { count: 0, windowEndsAt: current + LOGIN_WINDOW_MS };
      boundedSet(failures, address, fresh);
      return fresh;
    }
    return existing;
  }

  async function login(request, response) {
    if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, { allow: 'POST' });
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return sendJson(response, 415, { ok: false, error: 'JSON_REQUIRED' });
    }
    const current = nowMilliseconds(now);
    pruneAuthState(current);
    const address = clientAddress(request, trustProxy);
    const bucket = failureBucket(address, current);
    if (bucket.count >= LOGIN_FAILURE_LIMIT) {
      return sendJson(response, 429, { ok: false, error: 'TOO_MANY_ATTEMPTS' }, {
        'retry-after': String(Math.max(1, Math.ceil((bucket.windowEndsAt - current) / 1000))),
      });
    }
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      return sendJson(response, error && error.code === 'TOO_LARGE' ? 413 : 400, {
        ok: false,
        error: error && error.code === 'TOO_LARGE' ? 'REQUEST_TOO_LARGE' : 'INVALID_JSON',
      });
    }
    const password = body && !Array.isArray(body) ? body.password : null;
    if (!verifyAdminPassword(password, config.adminPasswordHash)) {
      bucket.count += 1;
      return sendJson(response, 401, { ok: false, error: 'INVALID_CREDENTIALS' });
    }
    failures.delete(address);
    const sessionId = crypto.randomBytes(24).toString('base64url');
    const expiresAt = current + sessionTtlMs;
    boundedSet(sessions, sessionId, expiresAt);
    const token = createSessionToken({ sessionId, secret: config.sessionSecret, issuedAt: current, expiresAt });
    return sendJson(response, 200, { ok: true }, {
      'set-cookie': sessionCookie(token, { secureCookies, sessionTtlMs }),
    });
  }

  async function dashboard(request, response) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return sendJson(response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, { allow: 'GET, HEAD' });
    }
    if (!activeSession(request)) return sendJson(response, 401, { ok: false, error: 'AUTHENTICATION_REQUIRED' });
    try {
      const data = projectDashboard(await loadDashboard());
      if (request.method === 'HEAD') {
        const body = JSON.stringify({ ok: true, data });
        response.writeHead(200, {
          ...securityHeaders('application/json; charset=utf-8'),
          'content-length': Buffer.byteLength(body),
        });
        return response.end();
      }
      return sendJson(response, 200, { ok: true, data });
    } catch {
      return sendJson(response, 502, { ok: false, error: 'DASHBOARD_UNAVAILABLE' });
    }
  }

  function logout(request, response) {
    if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, { allow: 'POST' });
    const verified = verifySession(cookieToken(request), config.sessionSecret, now);
    if (verified) sessions.delete(verified.sessionId);
    return sendJson(response, 200, { ok: true }, { 'set-cookie': clearSessionCookie(secureCookies) });
  }

  return function adminRequestHandler(request, response) {
    let pathname;
    try {
      pathname = new URL(request.url || '/', 'http://localhost').pathname;
    } catch {
      return sendJson(response, 400, { ok: false, error: 'INVALID_REQUEST' });
    }
    if (pathname === '/api/admin-login') {
      Promise.resolve(login(request, response)).catch(() => sendJson(response, 500, { ok: false, error: 'INTERNAL_ERROR' }));
      return;
    }
    if (pathname === '/api/admin-dashboard') {
      Promise.resolve(dashboard(request, response)).catch(() => sendJson(response, 500, { ok: false, error: 'INTERNAL_ERROR' }));
      return;
    }
    if (pathname === '/api/admin-logout') return logout(request, response);
    if (pathname.startsWith('/api/')) return sendJson(response, 404, { ok: false, error: 'NOT_FOUND' });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return sendJson(response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, { allow: 'GET, HEAD' });
    }
    if (pathname === '/') {
      response.writeHead(302, {
        ...securityHeaders('text/plain; charset=utf-8'),
        'content-length': '0',
        location: '/admin',
      });
      return response.end();
    }
    if (serveStatic(request, response, staticDir)) return;
    return sendJson(response, 404, { ok: false, error: 'NOT_FOUND' });
  };
}

function createAdminServer(options = {}) {
  const config = options.config || configFromEnvironment(options.environment || process.env);
  const staticDir = options.staticDir || path.resolve(__dirname, '..', 'dist');
  const handler = createAdminRequestHandler({
    staticDir,
    config,
    loadDashboard: options.loadDashboard,
  });
  return http.createServer(handler);
}

module.exports = {
  configFromEnvironment,
  createAdminRequestHandler,
  createAdminServer,
  hashAdminPassword,
  verifyAdminPassword,
  verifySession,
};
