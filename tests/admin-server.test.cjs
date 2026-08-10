const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  configFromEnvironment,
  createAdminServer,
  hashAdminPassword,
  verifyAdminPassword,
  verifySession,
} = require('../server/admin-server.cjs');
const { generateAdminSecrets } = require('../tools/generate-admin-secrets.cjs');

const PASSWORD = 'a-correct-local-password';
const SESSION_SECRET = 'session-secret-with-more-than-thirty-two-characters';

function fixtureDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-admin-'));
  fs.mkdirSync(path.join(directory, 'assets'));
  fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><title>Admin fixture</title>');
  fs.writeFileSync(path.join(directory, 'assets', 'entry.js'), 'export default true;');
  return directory;
}

function dashboardFixture() {
  return {
    generatedAt: '2035-01-15T09:00:00.000Z',
    privateTopLevel: 'must not leave the server',
    summary: { broadcasters: 1, recipients: 4, events: 1, receipts: 3, accepted: 2, privateNote: 'omit' },
    broadcasters: [{
      broadcasterId: 'demo-channel-a',
      stableStatus: 'live',
      lastObservedAt: '2035-01-15T09:00:00.000Z',
      activeSubscriptions: 4,
      currentlyEligibleRecipients: 3,
      privateField: 'omit',
    }],
    recipients: [{ recipientId: 'never-expose-this' }],
    events: [{
      eventId: 'demo-event-a',
      broadcasterId: 'demo-channel-a',
      status: 'live',
      denominator: 3,
      counts: { denominator: 3, accepted: 2, pending: 1, countConsistent: true, terminal: false, privateCount: 99 },
      receipts: [{ recipientId: 'never-expose-this' }],
    }],
  };
}

async function startAdmin({ nowRef = { value: Date.parse('2035-01-15T09:00:00.000Z') }, loadDashboard } = {}) {
  const staticDir = fixtureDirectory();
  const server = createAdminServer({
    staticDir,
    config: {
      adminPasswordHash: hashAdminPassword(PASSWORD, 'test-salt-value'),
      sessionSecret: SESSION_SECRET,
      sessionTtlMs: 60_000,
      secureCookies: false,
      trustProxy: false,
      now: () => nowRef.value,
    },
    loadDashboard: loadDashboard || (async () => dashboardFixture()),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    nowRef,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function login(baseUrl, password = PASSWORD, headers = {}) {
  return fetch(`${baseUrl}/api/admin-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ password }),
    redirect: 'manual',
  });
}

test('scrypt hashes have a strict, versioned format and reject malformed encodings', () => {
  const encoded = hashAdminPassword(PASSWORD, 'deterministic-salt');
  assert.match(encoded, /^scrypt\$v1\$n=16384\$r=8\$p=1\$l=64\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.equal(verifyAdminPassword(PASSWORD, encoded), true);
  assert.equal(verifyAdminPassword('incorrect-password', encoded), false);
  assert.equal(verifyAdminPassword(PASSWORD, `${encoded}$extra`), false);
  assert.equal(verifyAdminPassword(PASSWORD, encoded.replace('n=16384', 'n=32768')), false);
  assert.equal(verifyAdminPassword(PASSWORD, encoded.replace(/.$/, '*')), false);
  assert.throws(() => hashAdminPassword('too-short'), /at least 12/);
});

test('login creates a strict HttpOnly session and the dashboard projection omits recipient records', async (t) => {
  const runtime = await startAdmin();
  t.after(runtime.close);

  const anonymous = await fetch(`${runtime.baseUrl}/api/admin-dashboard`);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('cache-control'), 'no-store');
  assert.match(anonymous.headers.get('content-security-policy'), /frame-ancestors 'none'/);

  const response = await login(runtime.baseUrl);
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.doesNotMatch(setCookie, /; Secure/);
  const cookie = setCookie.split(';')[0];
  const token = cookie.slice(cookie.indexOf('=') + 1);
  const verified = verifySession(token, SESSION_SECRET, runtime.nowRef.value);
  assert.ok(verified);
  assert.equal(verifySession(`${token}x`, SESSION_SECRET, runtime.nowRef.value), null);

  const dashboard = await fetch(`${runtime.baseUrl}/api/admin-dashboard`, { headers: { cookie } });
  assert.equal(dashboard.status, 200);
  const payload = await dashboard.json();
  assert.deepEqual(Object.keys(payload.data).sort(), ['broadcasters', 'events', 'summary']);
  assert.equal(payload.data.summary.recipients, 4);
  assert.equal(payload.data.summary.privateNote, undefined);
  assert.equal(payload.data.broadcasters[0].activeSubscriptions, 4);
  assert.equal(payload.data.broadcasters[0].currentlyEligibleRecipients, 3);
  assert.equal(payload.data.events[0].counts.privateCount, undefined);
  assert.doesNotMatch(JSON.stringify(payload), /never-expose|privateTopLevel|privateField/);

  runtime.nowRef.value += 60_001;
  assert.equal(verifySession(token, SESSION_SECRET, runtime.nowRef.value), null);
  const expired = await fetch(`${runtime.baseUrl}/api/admin-dashboard`, { headers: { cookie } });
  assert.equal(expired.status, 401);
});

test('secure-cookie mode, logout, and fail-closed dashboard errors are explicit', async (t) => {
  const staticDir = fixtureDirectory();
  const server = createAdminServer({
    staticDir,
    config: {
      adminPasswordHash: hashAdminPassword(PASSWORD),
      sessionSecret: SESSION_SECRET,
      secureCookies: true,
    },
    loadDashboard: async () => { throw new Error('private storage detail'); },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const authenticated = await login(baseUrl);
  const setCookie = authenticated.headers.get('set-cookie');
  assert.match(setCookie, /; Secure/);
  const cookie = setCookie.split(';')[0];
  const unavailable = await fetch(`${baseUrl}/api/admin-dashboard`, { headers: { cookie } });
  assert.equal(unavailable.status, 502);
  assert.deepEqual(await unavailable.json(), { ok: false, error: 'DASHBOARD_UNAVAILABLE' });
  const logout = await fetch(`${baseUrl}/api/admin-logout`, { method: 'POST', headers: { cookie } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(`${baseUrl}/api/admin-dashboard`, { headers: { cookie } })).status, 401);
});

test('login rate limiting, JSON type checks, and the 64 KiB body limit run before authentication', async (t) => {
  const runtime = await startAdmin();
  t.after(runtime.close);
  const wrong = 'this-password-is-not-correct';
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await login(runtime.baseUrl, wrong)).status, 401);
  }
  const limited = await login(runtime.baseUrl, PASSWORD);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  runtime.nowRef.value += (15 * 60 * 1000) + 1;
  assert.equal((await login(runtime.baseUrl, PASSWORD)).status, 200);

  const second = await startAdmin();
  t.after(second.close);
  const wrongType = await fetch(`${second.baseUrl}/api/admin-login`, { method: 'POST', body: '{}' });
  assert.equal(wrongType.status, 415);
  const oversized = await fetch(`${second.baseUrl}/api/admin-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'x'.repeat(70 * 1024) }),
  });
  assert.equal(oversized.status, 413);
});

test('static serving is no-store, CSP protected, and cannot escape its root', async (t) => {
  const runtime = await startAdmin();
  t.after(runtime.close);
  const page = await fetch(`${runtime.baseUrl}/admin`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(page.headers.get('content-security-policy'), /object-src 'none'/);
  assert.match(await page.text(), /Admin fixture/);
  const asset = await fetch(`${runtime.baseUrl}/assets/entry.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /text\/javascript/);
  const escape = await fetch(`${runtime.baseUrl}/assets/%2e%2e/index.html`);
  assert.equal(escape.status, 404);
  const encodedSeparator = await fetch(`${runtime.baseUrl}/assets/%2e%2e%5cindex.html`);
  assert.equal(encodedSeparator.status, 404);
});

test('configuration defaults are local-server safe and trusted proxy mode is explicit', () => {
  const config = configFromEnvironment({
    ADMIN_PASSWORD_HASH: 'provided-for-later-validation',
    ADMIN_SESSION_SECRET: 'provided-for-later-validation',
  });
  assert.equal(config.secureCookies, true);
  assert.equal(config.trustProxy, false);
  assert.equal(config.sessionTtlMs, 8 * 60 * 60 * 1000);
  const explicit = configFromEnvironment({
    ADMIN_PASSWORD_HASH: 'x',
    ADMIN_SESSION_SECRET: 'y',
    ADMIN_COOKIE_SECURE: '0',
    ADMIN_TRUST_PROXY: '1',
    ADMIN_SESSION_TTL_MS: '60000',
  });
  assert.equal(explicit.secureCookies, false);
  assert.equal(explicit.trustProxy, true);
  assert.equal(explicit.sessionTtlMs, 60_000);
});

test('server construction fails closed without a valid hash, session secret, or dashboard adapter', () => {
  const staticDir = fixtureDirectory();
  const validHash = hashAdminPassword(PASSWORD);
  assert.throws(() => createAdminServer({ staticDir, config: { adminPasswordHash: '', sessionSecret: SESSION_SECRET }, loadDashboard: async () => ({}) }), /PASSWORD_HASH/);
  assert.throws(() => createAdminServer({ staticDir, config: { adminPasswordHash: validHash, sessionSecret: 'short' }, loadDashboard: async () => ({}) }), /SESSION_SECRET/);
  assert.throws(() => createAdminServer({ staticDir, config: { adminPasswordHash: validHash, sessionSecret: SESSION_SECRET } }), /loadDashboard/);
});

test('the secret generator emits one password, its matching hash, and three independent server secrets', () => {
  const values = generateAdminSecrets();
  assert.deepEqual(Object.keys(values), [
    'ADMIN_PASSWORD',
    'ADMIN_PASSWORD_HASH',
    'ADMIN_SESSION_SECRET',
    'OBSERVATION_SECRET',
    'OPERATOR_SECRET',
  ]);
  assert.equal(verifyAdminPassword(values.ADMIN_PASSWORD, values.ADMIN_PASSWORD_HASH), true);
  const independent = [values.ADMIN_PASSWORD, values.ADMIN_SESSION_SECRET, values.OBSERVATION_SECRET, values.OPERATOR_SECRET];
  assert.equal(new Set(independent).size, independent.length);
  assert.ok(independent.every((value) => value.length >= 32));
});
