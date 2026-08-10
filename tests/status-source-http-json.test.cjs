const test = require('node:test');
const assert = require('node:assert/strict');

const { createHttpJsonStatusSource } = require('../sources/http-json-status-source.cjs');

test('status source rejects timeout values that Node would clamp to a hot loop', () => {
  assert.throws(() => createHttpJsonStatusSource({
    id: 'source-a',
    url: 'https://status.example.invalid/live',
    timeoutMs: 2_147_483_648,
  }), /timeoutMs/);
});

test('status source can authenticate with a private bearer token without recording it as evidence', async () => {
  let requestHeaders;
  const source = createHttpJsonStatusSource({
    id: 'source-authenticated',
    url: 'https://status.example.invalid/live',
    bearerToken: 'private-status-token',
    fetch: async (_url, options) => {
      requestHeaders = options.headers;
      return new Response(JSON.stringify({ status: 'offline' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const result = await source.read();
  assert.equal(requestHeaders.authorization, 'Bearer private-status-token');
  assert.doesNotMatch(JSON.stringify(result.evidence), /private-status-token/);
});

test('an HTTPS JSON endpoint can report a live observation', async () => {
  const requests = [];
  const source = createHttpJsonStatusSource({
    id: 'primary-channel',
    url: 'https://status.example.test/channels/primary?fixture=omit-me',
    fetch: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ status: 'live' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    now: () => new Date('2035-01-15T12:00:00.000Z'),
  });

  const result = await source.read();

  assert.equal(result.status, 'live');
  assert.deepEqual(result.evidence, {
    kind: 'http-json',
    endpoint: 'https://status.example.test/channels/primary',
    observedAt: '2035-01-15T12:00:00.000Z',
    httpStatus: 200,
  });
  assert.equal(source.id, 'primary-channel');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://status.example.test/channels/primary?fixture=omit-me');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.headers.accept, 'application/json');
});

test('plain HTTP is rejected before any request unless it is an explicitly allowed loopback endpoint', () => {
  assert.throws(
    () => createHttpJsonStatusSource({
      id: 'insecure',
      url: 'http://status.example.test/channel',
      fetch: async () => { throw new Error('must not run'); },
    }),
    /HTTPS/i,
  );
  assert.throws(
    () => createHttpJsonStatusSource({
      id: 'private-network',
      url: 'http://192.168.1.20/status',
      allowLoopbackHttp: true,
      fetch: async () => { throw new Error('must not run'); },
    }),
    /HTTPS/i,
  );
});

test('a loopback HTTP endpoint works only with explicit opt-in', async () => {
  const source = createHttpJsonStatusSource({
    id: 'local-development',
    url: 'http://127.0.0.1:8787/status',
    allowLoopbackHttp: true,
    fetch: async () => new Response(JSON.stringify({ status: 'offline' }), { status: 200 }),
  });

  const result = await source.read();

  assert.equal(result.status, 'offline');
});

test('a network failure is uncertainty, never an offline result', async () => {
  const source = createHttpJsonStatusSource({
    id: 'primary-channel',
    url: 'https://status.example.test/channel',
    fetch: async () => { throw new Error('socket closed'); },
    now: () => new Date('2035-01-15T12:01:00.000Z'),
  });

  const result = await source.read();

  assert.equal(result.status, 'unknown');
  assert.equal(result.evidence.reason, 'network-error');
  assert.equal(result.evidence.observedAt, '2035-01-15T12:01:00.000Z');
  assert.equal(JSON.stringify(result).includes('socket closed'), false);
});

test('malformed JSON is reported as unknown without leaking the response body', async () => {
  const source = createHttpJsonStatusSource({
    id: 'primary-channel',
    url: 'https://status.example.test/channel',
    fetch: async () => new Response('<html>challenge secret</html>', { status: 200 }),
  });

  const result = await source.read();

  assert.equal(result.status, 'unknown');
  assert.equal(result.evidence.reason, 'invalid-json');
  assert.equal(JSON.stringify(result).includes('challenge secret'), false);
});

test('an oversized status response is rejected without buffering or exposing its content', async () => {
  const marker = 'private-marker-must-not-escape';
  const source = createHttpJsonStatusSource({
    id: 'primary-channel',
    url: 'https://status.example.test/channel',
    fetch: async () => new Response(JSON.stringify({
      status: 'live',
      padding: `${marker}${'x'.repeat(70 * 1024)}`,
    }), { status: 200 }),
  });

  const result = await source.read();

  assert.equal(result.status, 'unknown');
  assert.equal(result.evidence.reason, 'response-too-large');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(marker));
});

test('an HTTP security challenge is unknown rather than offline', async () => {
  const source = createHttpJsonStatusSource({
    id: 'primary-channel',
    url: 'https://status.example.test/channel',
    fetch: async () => new Response(JSON.stringify({ status: 'offline' }), { status: 403 }),
  });

  const result = await source.read();

  assert.equal(result.status, 'unknown');
  assert.equal(result.evidence.reason, 'http-error');
  assert.equal(result.evidence.httpStatus, 403);
});

test('only live, offline, and unknown are accepted endpoint states', async () => {
  const source = createHttpJsonStatusSource({
    id: 'primary-channel',
    url: 'https://status.example.test/channel',
    fetch: async () => new Response(JSON.stringify({ status: 'streaming' }), { status: 200 }),
  });

  const result = await source.read();

  assert.equal(result.status, 'unknown');
  assert.equal(result.evidence.reason, 'invalid-status');
});

test('a response reached through a redirect is never trusted', async () => {
  const source = createHttpJsonStatusSource({
    id: 'primary-channel',
    url: 'https://status.example.test/channel',
    fetch: async () => ({
      ok: true,
      status: 200,
      redirected: true,
      url: 'https://internal.example.test/admin',
      json: async () => ({ status: 'live' }),
    }),
  });

  const result = await source.read();

  assert.equal(result.status, 'unknown');
  assert.equal(result.evidence.reason, 'redirect-blocked');
});

test('a request timeout returns unknown and aborts the HTTP request', async () => {
  let receivedSignal;
  const source = createHttpJsonStatusSource({
    id: 'primary-channel',
    url: 'https://status.example.test/channel',
    timeoutMs: 5,
    fetch: async (_url, options) => {
      receivedSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
  });

  const result = await source.read();

  assert.equal(receivedSignal.aborted, true);
  assert.equal(result.status, 'unknown');
  assert.equal(result.evidence.reason, 'timeout');
});
