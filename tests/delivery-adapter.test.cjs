const test = require('node:test');
const assert = require('node:assert/strict');

const { createLocalInboxDelivery } = require('../adapters/delivery/local-inbox.cjs');
const { createWebhookDelivery } = require('../adapters/delivery/webhook.cjs');

const envelope = {
  idempotencyKey: 'event-1:person-1',
  eventId: 'event-1',
  broadcasterId: 'channel-a',
  recipientId: 'person-1',
  occurredAt: '2035-01-15T12:00:00.000Z',
};

test('local inbox accepts each idempotency key exactly once', async () => {
  const inbox = createLocalInboxDelivery();
  const first = await inbox.deliver(envelope);
  const second = await inbox.deliver(envelope);

  assert.equal(first.status, 'accepted');
  assert.equal(second.status, 'accepted');
  assert.equal(second.duplicate, true);
  assert.equal(inbox.list({ recipientId: 'person-1' }).length, 1);
});

test('webhook classifies 2xx as accepted and explicit non-2xx as failed', async () => {
  const requests = [];
  const accepted = createWebhookDelivery({
    url: 'https://notifications.example.test/live',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response('', { status: 202, headers: { 'x-request-id': 'req-1' } });
    },
  });
  const acceptedResult = await accepted.deliver(envelope);
  assert.equal(acceptedResult.status, 'accepted');
  assert.equal(acceptedResult.httpStatus, 202);
  assert.equal(requests[0].options.headers['idempotency-key'], envelope.idempotencyKey);
  assert.equal(requests[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(requests[0].options.body), envelope);

  const rejected = createWebhookDelivery({
    url: 'https://notifications.example.test/live',
    fetchImpl: async () => new Response('invalid recipient', { status: 422 }),
  });
  const rejectedResult = await rejected.deliver(envelope);
  assert.equal(rejectedResult.status, 'failed');
  assert.equal(rejectedResult.httpStatus, 422);
});

test('webhook timeout after the request may have started is ambiguous', async () => {
  const delivery = createWebhookDelivery({
    url: 'https://notifications.example.test/live',
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });

  const result = await delivery.deliver(envelope);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.code, 'request-outcome-unknown');
});

test('webhook requires HTTPS except explicitly enabled loopback HTTP', async () => {
  assert.throws(
    () => createWebhookDelivery({ url: 'http://notifications.example.test/live' }),
    /HTTPS/,
  );
  assert.throws(
    () => createWebhookDelivery({ url: 'http://127.0.0.1:8788/live' }),
    /allowInsecureLoopback/,
  );

  const local = createWebhookDelivery({
    url: 'http://127.0.0.1:8788/live',
    allowInsecureLoopback: true,
    fetchImpl: async () => new Response('', { status: 202 }),
  });
  assert.equal((await local.deliver(envelope)).status, 'accepted');
});

test('webhook rejects timer overflow, URL credentials, and header injection before network I/O', () => {
  assert.throws(() => createWebhookDelivery({
    url: 'https://notifications.example.test/live',
    timeoutMs: 2_147_483_648,
  }), /timeoutMs/);
  assert.throws(() => createWebhookDelivery({
    url: 'https://fixture-user:fictional-value@127.0.0.1/live',
  }), /credentials/);
  assert.throws(() => createWebhookDelivery({
    url: 'https://notifications.example.test/live',
    headers: { authorization: 'Bearer safe\r\ninjected: value' },
  }), /header value/);
});
