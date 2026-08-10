const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDemoDashboard, createDemoServer, demoPort } = require('../server/demo-server.cjs');

function staticFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-demo-'));
  fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><title>Fictional preview</title>');
  return directory;
}

test('the demo uses fictional core-shaped aggregates behind the real admin authentication seam', async (t) => {
  const password = 'temporary-demo-password';
  const server = createDemoServer({ staticDir: staticFixture(), password });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal(server.address().address, '127.0.0.1');
  assert.equal(server.demoPassword, password);

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${baseUrl}/api/admin-dashboard`)).status, 401);
  const login = await fetch(`${baseUrl}/api/admin-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await fetch(`${baseUrl}/api/admin-dashboard`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.data.summary.broadcasters, 3);
  assert.equal(payload.data.summary.bookkeepingPending, 1);
  assert.deepEqual(payload.data.broadcasters.map((item) => item.broadcasterId), ['demo-channel-a', 'demo-channel-b', 'demo-channel-c']);
  assert.deepEqual(payload.data.broadcasters.map((item) => item.stableStatus), ['live', 'offline', null]);
  assert.equal(payload.data.broadcasters[0].activeSubscriptions, 12);
  assert.equal(payload.data.broadcasters[0].currentlyEligibleRecipients, 12);
  assert.equal(payload.data.events[0].counts.terminal, true);
  assert.equal(payload.data.events[1].counts.accounted, 12);
  assert.equal(payload.data.events[1].counts.bookkeepingPending, 1);
  assert.equal(Object.hasOwn(payload.data, 'recipients'), false);
});

test('random demo passwords and dashboard fixtures are fresh for each instance', () => {
  const first = createDemoServer({ staticDir: staticFixture() });
  const second = createDemoServer({ staticDir: staticFixture() });
  assert.notEqual(first.demoPassword, second.demoPassword);
  assert.ok(first.demoPassword.length >= 12);
  const dashboard = createDemoDashboard();
  dashboard.summary.broadcasters = 99;
  assert.equal(createDemoDashboard().summary.broadcasters, 3);
});

test('demo port parsing defaults to 8788 and rejects unsafe values', () => {
  assert.equal(demoPort({}), 8788);
  assert.equal(demoPort({ DEMO_PORT: '9000' }), 9000);
  assert.throws(() => demoPort({ DEMO_PORT: '0' }), /DEMO_PORT/);
  assert.throws(() => demoPort({ DEMO_PORT: 'not-a-number' }), /DEMO_PORT/);
});
