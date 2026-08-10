const test = require('node:test');
const assert = require('node:assert/strict');

const { createPollScheduler } = require('../sources/poll-scheduler.cjs');

test('scheduler rejects timer values that Node would clamp to a hot loop', () => {
  const base = {
    broadcasterId: 'channel-a',
    statusSource: { id: 'source-a', read: async () => ({ status: 'offline' }) },
    onObservation: async () => {},
  };
  assert.throws(() => createPollScheduler({ ...base, pollIntervalMs: 2_147_483_648 }), /pollIntervalMs/);
  assert.throws(() => createPollScheduler({ ...base, confirmationIntervalMs: 2_147_483_648 }), /confirmationIntervalMs/);
});

test('a live state is submitted only after a 10-second live confirmation', async () => {
  const reads = [
    { status: 'live', evidence: { sample: 'first' } },
    { status: 'live', evidence: { sample: 'confirmation', observedAt: '2035-01-15T12:00:10.000Z' } },
  ];
  const waits = [];
  const observations = [];
  const scheduler = createPollScheduler({
    broadcasterId: 'channel-alpha',
    statusSource: {
      id: 'owner-json-endpoint',
      read: async () => reads.shift(),
    },
    sleep: async (milliseconds) => { waits.push(milliseconds); },
    onObservation: async (observation) => { observations.push(observation); },
    createCommandId: () => 'observation-001',
    now: () => new Date('2035-01-15T12:00:10.000Z'),
  });

  const result = await scheduler.pollNow();

  assert.deepEqual(waits, [10_000]);
  assert.equal(result.submitted, true);
  assert.deepEqual(observations, [{
    broadcasterId: 'channel-alpha',
    status: 'live',
    observationId: 'observation-001',
    commandId: 'observation-001',
    observedAt: '2035-01-15T12:00:10.000Z',
    source: 'owner-json-endpoint',
    evidence: {
      kind: 'confirmed-live',
      confirmationIntervalMs: 10_000,
      initialSample: 'first',
      confirmationSample: 'confirmation',
      confirmationObservedAt: '2035-01-15T12:00:10.000Z',
    },
  }]);
});

test('unknown during confirmation interrupts the live submission', async () => {
  const reads = [
    { status: 'live', evidence: { sample: 'first' } },
    { status: 'unknown', evidence: { reason: 'security-challenge' } },
  ];
  const observations = [];
  const scheduler = createPollScheduler({
    broadcasterId: 'channel-alpha',
    statusSource: { id: 'owner-json-endpoint', read: async () => reads.shift() },
    sleep: async () => {},
    onObservation: async (observation) => { observations.push(observation); },
  });

  const result = await scheduler.pollNow();

  assert.equal(result.status, 'unknown');
  assert.equal(result.submitted, true);
  assert.deepEqual(observations.map((item) => item.status), ['unknown']);
});

test('repeated live polls refresh health without creating a second transition id', async () => {
  const reads = ['live', 'live', 'live'];
  const observations = [];
  const scheduler = createPollScheduler({
    broadcasterId: 'channel-alpha',
    statusSource: {
      id: 'owner-json-endpoint',
      read: async () => ({ status: reads.shift(), evidence: {} }),
    },
    sleep: async () => {},
    onObservation: async (observation) => { observations.push(observation); },
    createCommandId: () => 'stable-command-id',
  });

  await scheduler.pollNow();
  const repeated = await scheduler.pollNow();

  assert.equal(repeated.submitted, false);
  assert.equal(observations.length, 2);
  assert.equal(observations[0].observationId, 'stable-command-id');
  assert.equal(Object.hasOwn(observations[1], 'observationId'), false);
  assert.equal(reads.length, 0);
});

test('start polls immediately and uses a 120-second recurring interval by default', async () => {
  const scheduled = [];
  const cleared = [];
  const handle = { unref() {} };
  const scheduler = createPollScheduler({
    broadcasterId: 'channel-alpha',
    statusSource: {
      id: 'owner-json-endpoint',
      read: async () => ({ status: 'offline', evidence: {} }),
    },
    onObservation: async () => {},
    setInterval: (callback, milliseconds) => {
      scheduled.push({ callback, milliseconds });
      return handle;
    },
    clearInterval: (value) => { cleared.push(value); },
  });

  const first = await scheduler.start();
  scheduler.stop();

  assert.equal(first.status, 'offline');
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].milliseconds, 120_000);
  assert.deepEqual(cleared, [handle]);
});

test('an offline reading rearms the next confirmed live period', async () => {
  const reads = ['live', 'live', 'offline', 'live', 'live'];
  const ids = ['period-1', 'period-offline', 'period-2'];
  const observations = [];
  const scheduler = createPollScheduler({
    broadcasterId: 'channel-alpha',
    statusSource: {
      id: 'owner-json-endpoint',
      read: async () => ({ status: reads.shift(), evidence: {} }),
    },
    sleep: async () => {},
    onObservation: async (observation) => { observations.push(observation); },
    createCommandId: () => ids.shift(),
  });

  await scheduler.pollNow();
  await scheduler.pollNow();
  await scheduler.pollNow();

  assert.deepEqual(observations.map((item) => item.status), ['live', 'offline', 'live']);
  assert.deepEqual(observations.map((item) => item.commandId), ['period-1', 'period-offline', 'period-2']);
});

test('offline and unknown transitions are submitted once so the core can preserve state safely', async () => {
  const reads = [
    { status: 'offline', evidence: { sample: 'offline-1' } },
    { status: 'offline', evidence: { sample: 'offline-2' } },
    { status: 'unknown', evidence: { reason: 'security-challenge' } },
    { status: 'unknown', evidence: { reason: 'security-challenge' } },
  ];
  const ids = ['offline-command', 'unknown-command'];
  const observations = [];
  const scheduler = createPollScheduler({
    broadcasterId: 'channel-alpha',
    statusSource: { id: 'owner-json-endpoint', read: async () => reads.shift() },
    onObservation: async (observation) => { observations.push(observation); },
    createCommandId: () => ids.shift(),
    now: () => new Date('2035-01-15T12:00:00.000Z'),
  });

  await scheduler.pollNow();
  await scheduler.pollNow();
  await scheduler.pollNow();
  await scheduler.pollNow();

  assert.deepEqual(observations.map((item) => item.status), ['offline', 'offline', 'unknown', 'unknown']);
  assert.equal(observations[2].evidence.reason, 'security-challenge');
  assert.deepEqual(
    observations.map((item) => item.observationId || null),
    ['offline-command', null, 'unknown-command', null],
  );
});
