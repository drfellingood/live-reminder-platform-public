const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createScheduledObservationHandler,
  createSelfHostedRuntime,
  loadRuntimeConfig,
  normalizeRuntimeConfig,
  resolveLocalSecrets,
} = require('../server/start.cjs');

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'live-reminder-runtime-'));
}

test('first local run creates persistent secrets and prints a password only once', () => {
  const dataDirectory = tempDirectory();
  const first = resolveLocalSecrets({ environment: {}, dataDirectory });
  const second = resolveLocalSecrets({ environment: {}, dataDirectory });

  assert.match(first.firstRunPassword, /^reminder-/);
  assert.equal(second.firstRunPassword, null);
  assert.deepEqual(second.environment, first.environment);
  assert.equal(fs.existsSync(path.join(dataDirectory, 'local-secrets.json')), true);
});

test('partial or implicit remote secrets fail closed', () => {
  const dataDirectory = tempDirectory();
  assert.throws(() => resolveLocalSecrets({
    environment: { ADMIN_PASSWORD_HASH: 'partial' },
    dataDirectory,
  }), /provide all local secrets together/);
  assert.throws(() => resolveLocalSecrets({
    environment: { SELF_HOSTED_ALLOW_REMOTE: '1' },
    dataDirectory,
  }), /remote self-hosting requires explicit/);
});

test('stored secret files cannot override unrelated runtime settings', () => {
  const dataDirectory = tempDirectory();
  resolveLocalSecrets({ environment: {}, dataDirectory });
  const filename = path.join(dataDirectory, 'local-secrets.json');
  const stored = JSON.parse(fs.readFileSync(filename, 'utf8'));
  stored.SELF_HOSTED_HOST = '0.0.0.0';
  fs.writeFileSync(filename, JSON.stringify(stored));

  assert.throws(
    () => resolveLocalSecrets({ environment: {}, dataDirectory }),
    /unknown field.*SELF_HOSTED_HOST/i,
  );
});

test('invalid explicit server secrets fail before creating data or bootstrapping recipients', async () => {
  const workingDirectory = tempDirectory();
  fs.mkdirSync(path.join(workingDirectory, 'dist'));
  fs.writeFileSync(path.join(workingDirectory, 'dist', 'index.html'), '<!doctype html><title>Self hosted</title>');

  await assert.rejects(createSelfHostedRuntime({
    workingDirectory,
    environment: {
      ADMIN_PASSWORD_HASH: 'not-a-scrypt-hash',
      ADMIN_SESSION_SECRET: 'session-secret-that-is-at-least-32-characters',
      OBSERVATION_SECRET: 'observation-secret-that-is-at-least-32-characters',
      OPERATOR_SECRET: 'operator-secret-that-is-at-least-32-characters',
    },
    runtimeConfig: {
      recipients: [{ id: 'must-not-be-created', credits: 10 }],
    },
  }), /PASSWORD_HASH/);
  assert.equal(fs.existsSync(path.join(workingDirectory, '.data')), false);
});

test('invalid stored secrets fail before opening the database or bootstrapping recipients', async () => {
  const workingDirectory = tempDirectory();
  fs.mkdirSync(path.join(workingDirectory, 'dist'));
  fs.mkdirSync(path.join(workingDirectory, '.data'));
  fs.writeFileSync(path.join(workingDirectory, 'dist', 'index.html'), '<!doctype html><title>Self hosted</title>');
  const secretsPath = path.join(workingDirectory, '.data', 'local-secrets.json');
  fs.writeFileSync(secretsPath, JSON.stringify({ ADMIN_PASSWORD_HASH: 'broken' }));

  await assert.rejects(createSelfHostedRuntime({
    workingDirectory,
    runtimeConfig: {
      recipients: [{ id: 'must-not-be-created', credits: 10 }],
    },
  }), /stored local secrets/i);

  assert.equal(fs.existsSync(path.join(workingDirectory, '.data', 'live-reminder.sqlite')), false);
  assert.equal(fs.readFileSync(secretsPath, 'utf8'), JSON.stringify({ ADMIN_PASSWORD_HASH: 'broken' }));
});

test('invalid startup configuration does not consume the one-time local password', async () => {
  const workingDirectory = tempDirectory();
  fs.mkdirSync(path.join(workingDirectory, 'dist'));
  fs.writeFileSync(path.join(workingDirectory, 'dist', 'index.html'), '<!doctype html><title>Self hosted</title>');

  await assert.rejects(
    createSelfHostedRuntime({
      workingDirectory,
      environment: { SELF_HOSTED_PORT: 'not-a-port' },
      runtimeConfig: {},
    }),
    /SELF_HOSTED_PORT/,
  );
  assert.equal(fs.existsSync(path.join(workingDirectory, '.data', 'local-secrets.json')), false);
});

test('worker batch size is rejected before startup when the core cannot execute it', () => {
  assert.throws(() => normalizeRuntimeConfig({ workerBatchSize: 1001 }), /workerBatchSize/);
  assert.throws(() => normalizeRuntimeConfig({ workerBatchSize: 0 }), /workerBatchSize/);
  assert.equal(normalizeRuntimeConfig({ workerBatchSize: 1000 }).workerBatchSize, 1000);
});

test('runtime JSON rejects mistyped collections, booleans, identifiers, duplicates, and overflowing timers', () => {
  assert.throws(() => normalizeRuntimeConfig({ recipients: {} }), /recipients/);
  assert.throws(() => normalizeRuntimeConfig({ statusSources: {} }), /statusSources/);
  assert.throws(() => normalizeRuntimeConfig({ policy: [] }), /policy/);
  assert.throws(() => normalizeRuntimeConfig({ recipients: [{ id: 'person-a', enabled: 'false' }] }), /enabled/);
  assert.throws(() => normalizeRuntimeConfig({ recipients: [{ id: 'person-a', subscriptions: 'channel-a' }] }), /subscriptions/);
  assert.throws(() => normalizeRuntimeConfig({ recipients: [{ id: 'x'.repeat(201) }] }), /at most 200/);
  assert.throws(() => normalizeRuntimeConfig({
    recipients: [{ id: 'person-a' }, { id: 'person-a' }],
  }), /duplicate recipient/);
  assert.throws(() => normalizeRuntimeConfig({
    statusSources: [
      { id: 'source-a', broadcasterId: 'channel-a', url: 'https://one.example.invalid/status' },
      { id: 'source-a', broadcasterId: 'channel-b', url: 'https://two.example.invalid/status' },
    ],
  }), /duplicate status source/);
  assert.throws(() => normalizeRuntimeConfig({
    statusSources: [
      { id: 'source-a', broadcasterId: 'channel-a', url: 'https://one.example.invalid/status' },
      { id: 'source-b', broadcasterId: 'channel-a', url: 'https://two.example.invalid/status' },
    ],
  }), /duplicate broadcaster/);
  assert.throws(() => normalizeRuntimeConfig({
    statusSources: [{
      id: 'source-a',
      broadcasterId: 'channel-a',
      url: 'https://status.example.invalid/live',
      pollIntervalMs: 2_147_483_648,
    }],
  }), /pollIntervalMs/);
});

test('runtime JSON rejects unknown top-level fields instead of silently using defaults', () => {
  assert.throws(
    () => normalizeRuntimeConfig({ workerBacthSize: 10 }),
    /unknown.*workerBacthSize/i,
  );
});

test('recipient configuration rejects misspelled fields before enabling anyone', () => {
  assert.throws(
    () => normalizeRuntimeConfig({ recipients: [{ id: 'person-a', enabledd: false }] }),
    /unknown.*enabledd/i,
  );
});

test('status-source configuration rejects misspelled timer fields', () => {
  assert.throws(
    () => normalizeRuntimeConfig({
      statusSources: [{
        id: 'source-a',
        broadcasterId: 'channel-a',
        url: 'https://status.example.invalid/live',
        pollintervalMs: 1_000,
      }],
    }),
    /unknown.*pollintervalMs/i,
  );
});

test('policy configuration rejects unknown fields instead of weakening accounting defaults', () => {
  assert.throws(
    () => normalizeRuntimeConfig({ policy: { creditCosts: 2 } }),
    /unknown.*creditCosts/i,
  );
});

test('invalid source URLs and database paths fail before a local password is consumed', async () => {
  for (const scenario of [
    {
      environment: {},
      runtimeConfig: {
        statusSources: [{
          id: 'source-a',
          broadcasterId: 'channel-a',
          url: 'http://public.example.invalid/status',
        }],
      },
    },
    {
      environment: { SELF_HOSTED_DATABASE: '../outside.sqlite' },
      runtimeConfig: {},
    },
  ]) {
    const workingDirectory = tempDirectory();
    fs.mkdirSync(path.join(workingDirectory, 'dist'));
    fs.writeFileSync(path.join(workingDirectory, 'dist', 'index.html'), '<!doctype html><title>Self hosted</title>');
    await assert.rejects(createSelfHostedRuntime({ workingDirectory, ...scenario }));
    assert.equal(fs.existsSync(path.join(workingDirectory, '.data', 'local-secrets.json')), false);
  }
});

test('the data directory cannot target the project root', async () => {
  const workingDirectory = tempDirectory();
  fs.mkdirSync(path.join(workingDirectory, 'dist'));
  fs.writeFileSync(path.join(workingDirectory, 'dist', 'index.html'), '<!doctype html><title>Self hosted</title>');

  await assert.rejects(
    createSelfHostedRuntime({
      workingDirectory,
      environment: { SELF_HOSTED_DATA_DIR: '.' },
      runtimeConfig: {},
    }),
    /SELF_HOSTED_DATA_DIR/,
  );
  assert.equal(fs.existsSync(path.join(workingDirectory, 'live-reminder.sqlite')), false);
  assert.equal(fs.existsSync(path.join(workingDirectory, 'local-secrets.json')), false);
});

test('the data directory cannot be a symbolic-link redirect', async () => {
  const workingDirectory = tempDirectory();
  const redirectedDirectory = tempDirectory();
  fs.mkdirSync(path.join(workingDirectory, 'dist'));
  fs.writeFileSync(path.join(workingDirectory, 'dist', 'index.html'), '<!doctype html><title>Self hosted</title>');
  fs.symlinkSync(redirectedDirectory, path.join(workingDirectory, '.data'), 'junction');

  await assert.rejects(
    createSelfHostedRuntime({ workingDirectory, runtimeConfig: {} }),
    /data directory.*symbolic link/i,
  );
  assert.deepEqual(fs.readdirSync(redirectedDirectory), []);
});

test('a slow delivery batch never blocks the next scheduler observation', async () => {
  let releaseWorker;
  const workerBlocked = new Promise((resolve) => { releaseWorker = resolve; });
  const commands = [];
  const handler = createScheduledObservationHandler({
    core: {
      async execute(command) {
        commands.push(command);
        return { action: 'stable-updated' };
      },
    },
    workerOnce: () => workerBlocked,
  });
  const completed = await Promise.race([
    handler({
      commandId: 'transport-only-id',
      broadcasterId: 'channel-a',
      status: 'offline',
      observationId: 'observation-a',
    }).then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 50)),
  ]);
  assert.equal(completed, true);
  assert.deepEqual(commands, [{
    kind: 'observe',
    broadcasterId: 'channel-a',
    status: 'offline',
    observationId: 'observation-a',
  }]);
  releaseWorker();
});

test('runtime config is optional and a configured recipient persists in SQLite', async () => {
  const workingDirectory = tempDirectory();
  fs.mkdirSync(path.join(workingDirectory, 'dist'));
  fs.writeFileSync(path.join(workingDirectory, 'dist', 'index.html'), '<!doctype html><title>Self hosted</title>');
  const runtime = await createSelfHostedRuntime({
    workingDirectory,
    environment: { SELF_HOSTED_PORT: '8799' },
    runtimeConfig: {
      recipients: [{ id: 'recipient-a', credits: 3, subscriptions: ['channel-a'] }],
      statusSources: [],
    },
  });
  const recipient = await runtime.core.read({ kind: 'recipient', recipientId: 'recipient-a' });
  assert.equal(recipient.availableCredits, 3);
  await runtime.stop();

  assert.equal(fs.existsSync(path.join(workingDirectory, '.data', 'live-reminder.sqlite')), true);
  assert.deepEqual(loadRuntimeConfig(path.join(workingDirectory, 'missing.json')).recipients, []);
});

test('read-only recovery mode performs no bootstrap, polling, delivery, or database mutation', async () => {
  const workingDirectory = tempDirectory();
  fs.mkdirSync(path.join(workingDirectory, 'dist'));
  fs.writeFileSync(path.join(workingDirectory, 'dist', 'index.html'), '<!doctype html><title>Self hosted</title>');
  const seed = await createSelfHostedRuntime({
    workingDirectory,
    runtimeConfig: { recipients: [{ id: 'recipient-a', credits: 3, subscriptions: ['channel-a'] }] },
  });
  await seed.stop();
  const databasePath = path.join(workingDirectory, '.data', 'live-reminder.sqlite');
  const secretsPath = path.join(workingDirectory, '.data', 'local-secrets.json');
  const beforeHash = crypto.createHash('sha256').update(fs.readFileSync(databasePath)).digest('hex');
  const beforeSecretsHash = crypto.createHash('sha256').update(fs.readFileSync(secretsPath)).digest('hex');

  const inspected = await createSelfHostedRuntime({
    workingDirectory,
    environment: { SELF_HOSTED_READ_ONLY: '1', SELF_HOSTED_PORT: '18977' },
    runtimeConfig: {
      recipients: [{ id: 'must-not-be-created', credits: 99, subscriptions: ['channel-b'] }],
      statusSources: [{
        id: 'must-not-poll',
        broadcasterId: 'channel-b',
        url: 'http://public.example.invalid/status',
      }],
    },
    setIntervalFn: () => { throw new Error('read-only mode scheduled a worker'); },
  });
  assert.equal(inspected.readOnly, true);
  assert.equal((await inspected.core.read({ kind: 'recipient', recipientId: 'recipient-a' })).availableCredits, 3);
  assert.equal(await inspected.core.read({ kind: 'recipient', recipientId: 'must-not-be-created' }), null);
  await inspected.start();
  await inspected.stop();

  const afterHash = crypto.createHash('sha256').update(fs.readFileSync(databasePath)).digest('hex');
  const afterSecretsHash = crypto.createHash('sha256').update(fs.readFileSync(secretsPath)).digest('hex');
  assert.equal(afterHash, beforeHash);
  assert.equal(afterSecretsHash, beforeSecretsHash);
  const allowedReadOnlyFiles = new Set([
    'live-reminder.sqlite',
    'live-reminder.sqlite-shm',
    'live-reminder.sqlite-wal',
    'local-secrets.json',
  ]);
  const unexpectedFiles = fs.readdirSync(path.join(workingDirectory, '.data'))
    .filter((entry) => !allowedReadOnlyFiles.has(entry));
  assert.deepEqual(unexpectedFiles, []);
});

test('read-only recovery mode refuses to create replacement credentials', async () => {
  const workingDirectory = tempDirectory();
  fs.mkdirSync(path.join(workingDirectory, 'dist'));
  fs.writeFileSync(path.join(workingDirectory, 'dist', 'index.html'), '<!doctype html><title>Self hosted</title>');
  fs.mkdirSync(path.join(workingDirectory, '.data'));
  const store = require('../adapters/storage/sqlite-store.cjs').createSqliteStore({
    filename: path.join(workingDirectory, '.data', 'live-reminder.sqlite'),
  });
  await store.close();

  await assert.rejects(
    createSelfHostedRuntime({
      workingDirectory,
      environment: { SELF_HOSTED_READ_ONLY: '1' },
      runtimeConfig: {},
    }),
    /existing local secrets|explicit server secrets/,
  );
  assert.equal(fs.existsSync(path.join(workingDirectory, '.data', 'local-secrets.json')), false);
});

test('zero-config loopback runtime issues a usable non-Secure local session cookie', async (t) => {
  const workingDirectory = tempDirectory();
  fs.mkdirSync(path.join(workingDirectory, 'dist'));
  fs.writeFileSync(path.join(workingDirectory, 'dist', 'index.html'), '<!doctype html><title>Self hosted</title>');
  const runtime = await createSelfHostedRuntime({ workingDirectory, runtimeConfig: {} });
  await new Promise((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => runtime.stop());
  const address = runtime.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${baseUrl}/api/admin-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: runtime.firstRunPassword }),
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie') || '';
  assert.doesNotMatch(setCookie, /;\s*Secure/i);

  const cookie = setCookie.split(';', 1)[0];
  const dashboard = await fetch(`${baseUrl}/api/admin-dashboard`, { headers: { cookie } });
  assert.equal(dashboard.status, 200);
  assert.equal((await dashboard.json()).ok, true);
});
