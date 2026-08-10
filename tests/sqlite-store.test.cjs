const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createReminderCore } = require('../core/reminder-core.cjs');
const { createSqliteStore } = require('../adapters/storage/sqlite-store.cjs');
const { createLocalInboxDelivery } = require('../adapters/delivery/local-inbox.cjs');

test('SQLite store preserves events, receipts, and accounting over a core restart', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-core-'));
  const databasePath = path.join(directory, 'reminders.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const first = createReminderCore({
    store: createSqliteStore({ filename: databasePath }),
    delivery: createLocalInboxDelivery(),
    clock: { now: () => new Date('2035-01-15T12:00:00.000Z') },
  });
  await first.execute({ kind: 'register-recipient', recipientId: 'person-1', credits: 0 });
  await first.execute({
    kind: 'grant-credits',
    grantId: 'purchase-persisted-001',
    recipientId: 'person-1',
    credits: 2,
  });
  await first.execute({ kind: 'subscribe', broadcasterId: 'channel-a', recipientId: 'person-1' });
  await first.execute({ kind: 'observe', broadcasterId: 'channel-a', status: 'offline' });
  const created = await first.execute({ kind: 'observe', broadcasterId: 'channel-a', status: 'live' });
  await first.close();

  const secondInbox = createLocalInboxDelivery();
  const second = createReminderCore({
    store: createSqliteStore({ filename: databasePath }),
    delivery: secondInbox,
    clock: { now: () => new Date('2035-01-15T12:01:00.000Z') },
  });
  const beforeWork = await second.read({ kind: 'event', eventId: created.eventId });
  assert.equal(beforeWork.counts.denominator, 1);
  assert.equal(beforeWork.counts.pending, 1);
  assert.equal(beforeWork.receipts[0].accountingStatus, 'reserved');
  const duplicateGrant = await second.execute({
    kind: 'grant-credits',
    grantId: 'purchase-persisted-001',
    recipientId: 'person-1',
    credits: 2,
  });
  assert.equal(duplicateGrant.action, 'grant-already-applied');
  assert.equal((await second.read({ kind: 'recipient', recipientId: 'person-1' })).availableCredits, 1);

  await second.execute({ kind: 'deliver-pending' });
  await second.close();

  const third = createReminderCore({
    store: createSqliteStore({ filename: databasePath }),
    delivery: createLocalInboxDelivery(),
    clock: { now: () => new Date('2035-01-15T12:02:00.000Z') },
  });
  const afterWork = await third.read({ kind: 'event', eventId: created.eventId });
  assert.equal(afterWork.counts.accepted, 1);
  assert.equal(afterWork.receipts[0].accountingStatus, 'consumed');
  const dashboard = await third.read({ kind: 'dashboard' });
  assert.equal(dashboard.recipients[0].availableCredits, 1);
  await third.close();
});

test('first operation after restart converts abandoned in-flight receipts to ambiguous', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-core-abandoned-'));
  const databasePath = path.join(directory, 'reminders.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const firstStore = createSqliteStore({ filename: databasePath });
  const first = createReminderCore({
    store: firstStore,
    delivery: createLocalInboxDelivery(),
    clock: { now: () => new Date('2035-01-15T12:00:00.000Z') },
  });
  await first.execute({ kind: 'register-recipient', recipientId: 'person-1', credits: 1 });
  await first.execute({ kind: 'subscribe', broadcasterId: 'channel-a', recipientId: 'person-1' });
  await first.execute({ kind: 'observe', broadcasterId: 'channel-a', status: 'offline' });
  const created = await first.execute({ kind: 'observe', broadcasterId: 'channel-a', status: 'live' });
  await firstStore.transact((state) => {
    const receipt = Object.values(state.receipts)[0];
    receipt.deliveryStatus = 'in-flight';
    receipt.attemptCount = 1;
  });
  await first.close();

  const second = createReminderCore({
    store: createSqliteStore({ filename: databasePath }),
    delivery: createLocalInboxDelivery(),
    clock: { now: () => new Date('2035-01-15T12:01:00.000Z') },
  });
  const recovered = await second.read({ kind: 'event', eventId: created.eventId });
  assert.equal(recovered.receipts[0].deliveryStatus, 'ambiguous');
  assert.equal(recovered.receipts[0].accountingStatus, 'reserved');
  assert.equal(recovered.counts.terminal, false);
  const dashboard = await second.read({ kind: 'dashboard' });
  assert.equal(dashboard.summary.bookkeepingPending, 1);
  await second.close();
});

test('read-only SQLite inspection preserves abandoned evidence byte for byte', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-core-read-only-'));
  const databasePath = path.join(directory, 'reminders.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const writableStore = createSqliteStore({ filename: databasePath });
  const writableCore = createReminderCore({
    store: writableStore,
    delivery: createLocalInboxDelivery(),
    clock: { now: () => new Date('2035-01-15T12:00:00.000Z') },
  });
  await writableCore.execute({ kind: 'register-recipient', recipientId: 'person-1', credits: 1 });
  await writableCore.execute({ kind: 'subscribe', broadcasterId: 'channel-a', recipientId: 'person-1' });
  await writableCore.execute({ kind: 'observe', broadcasterId: 'channel-a', status: 'offline' });
  const created = await writableCore.execute({ kind: 'observe', broadcasterId: 'channel-a', status: 'live' });
  await writableStore.transact((state) => {
    Object.values(state.receipts)[0].deliveryStatus = 'in-flight';
  });
  await writableCore.close();
  const before = fs.readFileSync(databasePath);

  const readOnlyStore = createSqliteStore({ filename: databasePath, readOnly: true });
  const readOnlyCore = createReminderCore({
    store: readOnlyStore,
    delivery: createLocalInboxDelivery(),
    readOnly: true,
  });
  const event = await readOnlyCore.read({ kind: 'event', eventId: created.eventId });
  assert.equal(event.receipts[0].deliveryStatus, 'in-flight');
  await assert.rejects(readOnlyCore.execute({ kind: 'deliver-pending' }), /read-only/);
  await readOnlyCore.close();

  assert.deepEqual(fs.readFileSync(databasePath), before);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(databasePath).mode & 0o777, 0o600);
  }
});
