const test = require('node:test');
const assert = require('node:assert/strict');

const { createReminderCore } = require('../core/reminder-core.cjs');
const { createMemoryStore } = require('../adapters/storage/memory-store.cjs');
const { createLocalInboxDelivery } = require('../adapters/delivery/local-inbox.cjs');

function fixedClock(iso = '2035-01-15T12:00:00.000Z') {
  let current = Date.parse(iso);
  return {
    now: () => new Date(current),
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}

async function registerAndSubscribe(core, broadcasterId, recipientId, credits = 1) {
  await core.execute({
    kind: 'register-recipient',
    recipientId,
    credits,
  });
  await core.execute({
    kind: 'subscribe',
    broadcasterId,
    recipientId,
  });
}

test('unknown observations preserve stable state, create no event, and reserve no credit', async () => {
  const clock = fixedClock();
  const core = createReminderCore({
    store: createMemoryStore(),
    delivery: createLocalInboxDelivery(),
    clock,
  });

  await registerAndSubscribe(core, 'channel-a', 'person-1', 2);
  await core.execute({ kind: 'observe', broadcasterId: 'channel-a', status: 'offline' });
  clock.advance(1_000);
  const result = await core.execute({
    kind: 'observe',
    broadcasterId: 'channel-a',
    status: 'unknown',
    observationId: 'probe-timeout-1',
  });

  assert.equal(result.action, 'ignored-unknown');
  const dashboard = await core.read({ kind: 'dashboard' });
  assert.equal(dashboard.broadcasters[0].stableStatus, 'offline');
  assert.equal(dashboard.summary.events, 0);
  assert.equal(dashboard.recipients[0].availableCredits, 2);
  await core.close();
});

test('future observations and conflicting observation ids cannot poison stable state', async () => {
  const clock = fixedClock();
  const core = createReminderCore({
    store: createMemoryStore(),
    delivery: createLocalInboxDelivery(),
    clock,
  });

  await core.execute({
    kind: 'observe',
    broadcasterId: 'channel-a',
    status: 'offline',
    observationId: 'fixed-observation-id',
    observedAt: '2035-01-15T12:00:00.000Z',
  });
  await assert.rejects(
    core.execute({
      kind: 'observe',
      broadcasterId: 'channel-a',
      status: 'live',
      observationId: 'fixed-observation-id',
      observedAt: '2035-01-15T12:00:00.000Z',
    }),
    /observationId/,
  );
  await assert.rejects(
    core.execute({
      kind: 'observe',
      broadcasterId: 'channel-a',
      status: 'live',
      observationId: 'future-observation-id',
      observedAt: '2035-01-15T13:00:00.000Z',
    }),
    /future/i,
  );
  const dashboard = await core.read({ kind: 'dashboard' });
  assert.equal(dashboard.broadcasters[0].stableStatus, 'offline');
  assert.equal(dashboard.summary.events, 0);
  await core.close();
});

test('reserved JavaScript object keys are rejected before they can pollute shared prototypes', async () => {
  const core = createReminderCore({
    store: createMemoryStore(),
    delivery: createLocalInboxDelivery(),
    clock: fixedClock(),
  });
  const pollutedKeys = ['stableStatus', 'lastObservedAt', 'lastEventId', 'lastUnknownAt', 'lastSource', 'updatedAt'];

  try {
    await assert.rejects(
      core.execute({ kind: 'observe', broadcasterId: '__proto__', status: 'offline' }),
      /reserved object key/i,
    );
  } finally {
    for (const key of pollutedKeys) delete Object.prototype[key];
    await core.close();
  }
});

test('offline to live creates one idempotent event and freezes its eligible denominator', async () => {
  const clock = fixedClock();
  const core = createReminderCore({
    store: createMemoryStore(),
    delivery: createLocalInboxDelivery(),
    clock,
  });

  await registerAndSubscribe(core, 'channel-a', 'person-1', 2);
  await registerAndSubscribe(core, 'channel-a', 'person-2', 0);
  await core.execute({ kind: 'observe', broadcasterId: 'channel-a', status: 'offline' });
  clock.advance(1_000);
  const first = await core.execute({
    kind: 'observe',
    broadcasterId: 'channel-a',
    status: 'live',
    observationId: 'live-proof-1',
    source: 'automatic',
  });
  const duplicate = await core.execute({
    kind: 'observe',
    broadcasterId: 'channel-a',
    status: 'live',
    observationId: 'live-proof-2',
  });

  assert.equal(first.action, 'event-created');
  assert.equal(first.eligibleRecipientCount, 1);
  assert.equal(duplicate.action, 'stable-no-change');
  assert.equal(duplicate.eventId, first.eventId);

  await registerAndSubscribe(core, 'channel-a', 'person-3', 5);
  const event = await core.read({ kind: 'event', eventId: first.eventId });
  assert.deepEqual(event.eligibleRecipientIds, ['person-1']);
  assert.equal(event.counts.denominator, 1);
  assert.equal(event.receipts.length, 1);
  assert.equal(event.receipts[0].idempotencyKey, `${first.eventId}:person-1`);
  assert.equal(event.receipts[0].accountingStatus, 'reserved');

  const dashboard = await core.read({ kind: 'dashboard' });
  assert.equal(dashboard.summary.events, 1);
  assert.equal(dashboard.summary.receipts, 1);
  assert.equal(dashboard.broadcasters[0].activeSubscriptions, 3);
  assert.equal(dashboard.broadcasters[0].currentlyEligibleRecipients, 2);
  assert.equal(dashboard.recipients.find((item) => item.recipientId === 'person-1').availableCredits, 1);
  await core.close();
});

test('worker records accepted, explicit failed, and ambiguous evidence with exactly-once accounting', async () => {
  const outcomes = new Map([
    ['person-a', { status: 'accepted', providerReference: 'provider-1' }],
    ['person-b', { status: 'failed', code: 'invalid-recipient' }],
    ['person-c', { status: 'ambiguous', code: 'timeout-after-start' }],
  ]);
  const attempts = [];
  const delivery = {
    async deliver(envelope) {
      attempts.push(envelope.idempotencyKey);
      return outcomes.get(envelope.recipientId);
    },
  };
  const core = createReminderCore({
    store: createMemoryStore(),
    delivery,
    clock: fixedClock(),
  });

  for (const recipientId of outcomes.keys()) {
    await registerAndSubscribe(core, 'channel-a', recipientId, 1);
  }
  await core.execute({ kind: 'observe', broadcasterId: 'channel-a', status: 'offline' });
  const created = await core.execute({ kind: 'observe', broadcasterId: 'channel-a', status: 'live' });
  const worked = await core.execute({ kind: 'deliver-pending', limit: 10 });

  assert.deepEqual(worked.counts, { claimed: 3, accepted: 1, failed: 1, ambiguous: 1 });
  assert.equal(new Set(attempts).size, 3);

  const event = await core.read({ kind: 'event', eventId: created.eventId });
  assert.deepEqual(event.counts, {
    denominator: 3,
    pending: 0,
    inFlight: 0,
    accepted: 1,
    failed: 1,
    ambiguous: 1,
    bookkeepingPending: 1,
    accounted: 3,
    countConsistent: true,
    terminal: false,
  });
  assert.equal(event.receipts.find((item) => item.recipientId === 'person-a').accountingStatus, 'consumed');
  assert.equal(event.receipts.find((item) => item.recipientId === 'person-b').accountingStatus, 'refunded');
  assert.equal(event.receipts.find((item) => item.recipientId === 'person-c').accountingStatus, 'reserved');

  const afterFirst = await core.read({ kind: 'dashboard' });
  assert.equal(afterFirst.summary.bookkeepingPending, 1);
  assert.equal(afterFirst.recipients.find((item) => item.recipientId === 'person-a').availableCredits, 0);
  assert.equal(afterFirst.recipients.find((item) => item.recipientId === 'person-b').availableCredits, 1);
  assert.equal(afterFirst.recipients.find((item) => item.recipientId === 'person-c').availableCredits, 0);

  const resolvedOnce = await core.execute({
    kind: 'resolve-delivery',
    resolutionId: 'resolution-person-c-failed',
    eventId: created.eventId,
    recipientId: 'person-c',
    outcome: 'failed',
    code: 'provider-confirmed-not-accepted',
  });
  const resolvedTwice = await core.execute({
    kind: 'resolve-delivery',
    resolutionId: 'resolution-person-c-failed',
    eventId: created.eventId,
    recipientId: 'person-c',
    outcome: 'failed',
    code: 'provider-confirmed-not-accepted',
  });
  assert.equal(resolvedOnce.action, 'resolved');
  assert.equal(resolvedTwice.action, 'resolution-already-applied');

  const afterResolution = await core.read({ kind: 'dashboard' });
  assert.equal(afterResolution.recipients.find((item) => item.recipientId === 'person-c').availableCredits, 1);
  const finalEvent = await core.read({ kind: 'event', eventId: created.eventId });
  assert.equal(finalEvent.counts.countConsistent, true);
  assert.equal(finalEvent.counts.terminal, true);

  const noReplay = await core.execute({ kind: 'deliver-pending' });
  assert.equal(noReplay.counts.claimed, 0);
  assert.equal(attempts.length, 3);
  await core.close();
});

test('credit grants require a persistent idempotency key and never apply twice', async () => {
  const core = createReminderCore({
    store: createMemoryStore(),
    delivery: createLocalInboxDelivery(),
    clock: fixedClock(),
  });
  await core.execute({ kind: 'register-recipient', recipientId: 'person-1', credits: 0 });
  await assert.rejects(
    core.execute({ kind: 'grant-credits', recipientId: 'person-1', credits: 3 }),
    /grantId/,
  );

  const first = await core.execute({
    kind: 'grant-credits',
    grantId: 'purchase-001',
    recipientId: 'person-1',
    credits: 3,
  });
  const duplicate = await core.execute({
    kind: 'grant-credits',
    grantId: 'purchase-001',
    recipientId: 'person-1',
    credits: 3,
  });
  assert.equal(first.action, 'credits-granted');
  assert.equal(duplicate.action, 'grant-already-applied');
  assert.equal((await core.read({ kind: 'recipient', recipientId: 'person-1' })).availableCredits, 3);
  await assert.rejects(
    core.execute({
      kind: 'grant-credits',
      grantId: 'purchase-001',
      recipientId: 'person-1',
      credits: 4,
    }),
    /conflicts/,
  );
  await core.close();
});

test('boolean controls and credit totals fail closed instead of coercing unsafe input', async () => {
  const core = createReminderCore({
    store: createMemoryStore(),
    delivery: createLocalInboxDelivery(),
    clock: fixedClock(),
  });
  await core.execute({
    kind: 'register-recipient',
    recipientId: 'person-max',
    credits: Number.MAX_SAFE_INTEGER,
  });

  await assert.rejects(
    core.execute({ kind: 'register-recipient', recipientId: 'person-disabled', enabled: 'false' }),
    /boolean/,
  );
  await assert.rejects(
    core.execute({ kind: 'subscribe', recipientId: 'person-max', broadcasterId: 'channel-a', active: 'false' }),
    /boolean/,
  );
  await assert.rejects(
    core.execute({ kind: 'grant-credits', grantId: 'overflow-grant', recipientId: 'person-max', credits: 1 }),
    /safe integer/,
  );
  const recipient = await core.read({ kind: 'recipient', recipientId: 'person-max' });
  assert.equal(recipient.availableCredits, Number.MAX_SAFE_INTEGER);
  await core.close();
});

test('late unknown observations never move the latest unknown timestamp backwards', async () => {
  const core = createReminderCore({
    store: createMemoryStore(),
    delivery: createLocalInboxDelivery(),
    clock: fixedClock(),
  });
  await core.execute({
    kind: 'observe',
    broadcasterId: 'channel-a',
    status: 'unknown',
    observationId: 'unknown-newer',
    observedAt: '2035-01-15T12:00:00.000Z',
  });
  await core.execute({
    kind: 'observe',
    broadcasterId: 'channel-a',
    status: 'unknown',
    observationId: 'unknown-older',
    observedAt: '2035-01-15T11:00:00.000Z',
  });
  const dashboard = await core.read({ kind: 'dashboard' });
  assert.equal(dashboard.broadcasters[0].lastUnknownAt, '2035-01-15T12:00:00.000Z');
  await core.close();
});

test('read-only core allows evidence reads but rejects every command without recovery writes', async () => {
  const store = createMemoryStore();
  const core = createReminderCore({
    store,
    delivery: createLocalInboxDelivery(),
    clock: fixedClock(),
    readOnly: true,
  });
  const dashboard = await core.read({ kind: 'dashboard' });
  assert.equal(dashboard.summary.events, 0);
  await assert.rejects(
    core.execute({ kind: 'observe', broadcasterId: 'channel-a', status: 'offline' }),
    /read-only/,
  );
  await core.close();
});

test('observe stores bounded flat evidence and rejects non-plain or nested evidence', async () => {
  const core = createReminderCore({
    store: createMemoryStore(),
    delivery: createLocalInboxDelivery(),
    clock: fixedClock(),
  });
  await core.execute({
    kind: 'observe',
    broadcasterId: 'channel-a',
    status: 'offline',
    source: 'poller',
  });
  const created = await core.execute({
    kind: 'observe',
    broadcasterId: 'channel-a',
    status: 'live',
    source: 'poller',
    evidence: { httpStatus: 200, liveFlag: true, requestId: 'probe-1' },
  });
  const event = await core.read({ kind: 'event', eventId: created.eventId });
  assert.equal(event.source, 'poller');
  assert.deepEqual(event.evidence, { httpStatus: 200, liveFlag: true, requestId: 'probe-1' });
  await assert.rejects(
    core.execute({
      kind: 'observe',
      broadcasterId: 'channel-b',
      status: 'live',
      evidence: { nested: { unsafe: true } },
    }),
    /evidence/,
  );
  await core.close();
});

test('one core rejects concurrent deliver-pending workers', async () => {
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const releasePromise = new Promise((resolve) => { release = resolve; });
  const core = createReminderCore({
    store: createMemoryStore(),
    delivery: {
      async deliver() {
        started();
        await releasePromise;
        return { status: 'accepted' };
      },
    },
    clock: fixedClock(),
  });
  await registerAndSubscribe(core, 'channel-a', 'person-1', 1);
  await registerAndSubscribe(core, 'channel-a', 'person-2', 1);
  await registerAndSubscribe(core, 'channel-a', 'person-3', 1);
  await core.execute({ kind: 'observe', broadcasterId: 'channel-a', status: 'offline' });
  const created = await core.execute({ kind: 'observe', broadcasterId: 'channel-a', status: 'live' });

  const firstWorker = core.execute({ kind: 'deliver-pending' });
  await startedPromise;
  const whileFirstAttemptIsBlocked = await core.read({ kind: 'event', eventId: created.eventId });
  assert.equal(whileFirstAttemptIsBlocked.counts.inFlight, 1);
  assert.equal(whileFirstAttemptIsBlocked.counts.pending, 2);
  await assert.rejects(core.execute({ kind: 'deliver-pending' }), /already running/);
  release();
  await firstWorker;
  await core.close();
});

test('sender acceptance is reported as accepted evidence, never as handset delivery', async () => {
  const core = createReminderCore({
    store: createMemoryStore(),
    delivery: { deliver: async () => ({ status: 'accepted' }) },
    clock: fixedClock(),
  });
  await registerAndSubscribe(core, 'channel-a', 'person-1', 1);
  await core.execute({ kind: 'observe', broadcasterId: 'channel-a', status: 'offline' });
  const created = await core.execute({ kind: 'observe', broadcasterId: 'channel-a', status: 'live' });
  await core.execute({ kind: 'deliver-pending' });

  const event = await core.read({ kind: 'event', eventId: created.eventId });
  assert.equal(event.receipts[0].deliveryStatus, 'accepted');
  assert.equal(event.receipts[0].handsetDisplayed, 'unverified');
  assert.equal(Object.hasOwn(event.counts, 'delivered'), false);
  await core.close();
});
