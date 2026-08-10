const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createLocalInboxDelivery } = require('../adapters/delivery/local-inbox.cjs');
const { createMemoryStore } = require('../adapters/storage/memory-store.cjs');
const { createReminderCore } = require('../core/reminder-core.cjs');
const { createSelfHostedServer } = require('../server/self-hosted-server.cjs');
const { hashAdminPassword } = require('../server/admin-server.cjs');
const { createPollScheduler } = require('../sources/poll-scheduler.cjs');

async function configuredCore() {
  const delivery = createLocalInboxDelivery({ clock: () => new Date('2035-01-15T12:00:20.000Z') });
  const core = createReminderCore({
    store: createMemoryStore(),
    delivery,
    clock: () => new Date('2035-01-15T12:00:20.000Z'),
  });
  for (const recipientId of ['recipient-a', 'recipient-b', 'recipient-c']) {
    await core.execute({ kind: 'register-recipient', recipientId, credits: 2 });
    await core.execute({ kind: 'subscribe', broadcasterId: 'channel-a', recipientId });
  }
  return { core, delivery };
}

test('automatic polling confirms live, freezes every eligible recipient, and delivers once', async (t) => {
  const { core, delivery } = await configuredCore();
  t.after(() => core.close());
  const readings = ['offline', 'live', 'live', 'live'];
  const scheduler = createPollScheduler({
    broadcasterId: 'channel-a',
    statusSource: {
      id: 'owned-status-endpoint',
      read: async () => ({ status: readings.shift(), evidence: { httpStatus: 200 } }),
    },
    sleep: async (milliseconds) => assert.equal(milliseconds, 10_000),
    now: () => new Date('2035-01-15T12:00:00.000Z'),
    createCommandId: (() => {
      const ids = ['offline-1', 'live-1'];
      return () => ids.shift();
    })(),
    onObservation: async ({ commandId: _commandId, ...observation }) => {
      await core.execute({ kind: 'observe', ...observation });
      await core.execute({ kind: 'deliver-pending' });
    },
  });

  await scheduler.pollNow();
  const live = await scheduler.pollNow();
  const duplicate = await scheduler.pollNow();
  const dashboard = await core.read({ kind: 'dashboard' });

  assert.equal(live.submitted, true);
  assert.equal(duplicate.submitted, false);
  assert.equal(dashboard.events.length, 1);
  assert.equal(dashboard.events[0].denominator, 3);
  assert.deepEqual(dashboard.events[0].counts, {
    denominator: 3,
    pending: 0,
    inFlight: 0,
    accepted: 3,
    failed: 0,
    ambiguous: 0,
    bookkeepingPending: 0,
    accounted: 3,
    countConsistent: true,
    terminal: true,
  });
  assert.equal(delivery.list().length, 3);
  assert.ok(delivery.list().every((item) => item.handsetDisplayed === 'unverified'));
});

test('authenticated manual observation uses the real core and creates the same per-recipient evidence', async (t) => {
  const { core, delivery } = await configuredCore();
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-reminder-flow-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>Flow</title>');
  const secret = 'manual-observation-secret-with-32-characters';
  const server = createSelfHostedServer({
    staticDir,
    core,
    config: {
      adminPasswordHash: hashAdminPassword('manual-admin-password', 'flow-test-salt'),
      sessionSecret: 'manual-session-secret-with-at-least-32-chars',
      observationSecret: secret,
      operatorSecret: 'manual-operator-secret-with-32-characters',
      secureCookies: false,
      now: () => Date.parse('2035-01-15T12:00:00.000Z'),
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await core.close();
  });
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/observations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      broadcasterId: 'channel-a',
      status: 'live',
      observationId: 'manual-live-1',
      observedAt: '2035-01-15T12:00:00.000Z',
      source: 'authorized-operator',
      evidence: { reason: 'manual-confirmation' },
    }),
  });
  assert.equal(response.status, 202);

  await core.execute({ kind: 'deliver-pending' });
  const dashboard = await core.read({ kind: 'dashboard' });
  assert.equal(dashboard.events[0].source, 'authorized-operator');
  assert.equal(dashboard.events[0].denominator, 3);
  assert.equal(dashboard.events[0].counts.accepted, 3);
  assert.equal(delivery.list().length, 3);
});
