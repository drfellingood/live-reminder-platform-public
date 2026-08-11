'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { createReminderCore } = require('../core/reminder-core.cjs');
const { createLocalInboxDelivery } = require('../adapters/delivery/local-inbox.cjs');
const { createWebhookDelivery } = require('../adapters/delivery/webhook.cjs');
const { createSqliteStore } = require('../adapters/storage/sqlite-store.cjs');
const { createHttpJsonStatusSource } = require('../sources/http-json-status-source.cjs');
const { createPollScheduler } = require('../sources/poll-scheduler.cjs');
const { hashAdminPassword } = require('./admin-server.cjs');
const {
  configFromEnvironment,
  createSelfHostedServer,
} = require('./self-hosted-server.cjs');

const DEFAULT_DATA_DIRECTORY = '.data';
const DEFAULT_CONFIG_FILE = 'config/self-hosted.json';
const DEFAULT_WORKER_INTERVAL_MS = 1_000;
const MAX_TIMER_MS = 2_147_483_647;
const SERVER_SECRET_NAMES = Object.freeze([
  'ADMIN_PASSWORD_HASH',
  'ADMIN_SESSION_SECRET',
  'OBSERVATION_SECRET',
  'OPERATOR_SECRET',
]);

async function createSelfHostedRuntime({
  environment = process.env,
  workingDirectory = process.cwd(),
  staticDir = path.resolve(workingDirectory, 'dist'),
  fetchImpl = globalThis.fetch,
  now = Date,
  runtimeConfig,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  const resolvedWorkingDirectory = path.resolve(workingDirectory);
  const dataDirectory = path.resolve(
    resolvedWorkingDirectory,
    environment.SELF_HOSTED_DATA_DIR || DEFAULT_DATA_DIRECTORY,
  );
  validateDataDirectory(dataDirectory, resolvedWorkingDirectory);
  const preparedEnvironment = { ...environment };
  const readOnly = preparedEnvironment.SELF_HOSTED_READ_ONLY === '1';
  const configuredHost = String(preparedEnvironment.SELF_HOSTED_HOST || '127.0.0.1').trim();
  if (preparedEnvironment.ADMIN_COOKIE_SECURE === undefined && isLoopbackHost(configuredHost)) {
    preparedEnvironment.ADMIN_COOKIE_SECURE = '0';
  }
  preflightServerEnvironment(preparedEnvironment);
  const config = runtimeConfig
    ? normalizeRuntimeConfig(runtimeConfig)
    : loadRuntimeConfig(path.resolve(
      workingDirectory,
      environment.SELF_HOSTED_CONFIG || DEFAULT_CONFIG_FILE,
    ));
  const workerIntervalMs = boundedInteger(
    Number(environment.SELF_HOSTED_WORKER_INTERVAL_MS || DEFAULT_WORKER_INTERVAL_MS),
    1,
    MAX_TIMER_MS,
    'SELF_HOSTED_WORKER_INTERVAL_MS',
  );
  const databaseFile = resolveDatabaseFilename(dataDirectory, environment.SELF_HOSTED_DATABASE);
  const delivery = readOnly ? createLocalInboxDelivery() : createDelivery({ environment, fetchImpl });
  const preparedSources = (readOnly ? [] : config.statusSources).map((definition) => ({
    definition,
    source: createHttpJsonStatusSource({
      id: definition.id,
      url: definition.url,
      timeoutMs: definition.timeoutMs,
      allowLoopbackHttp: definition.allowLoopbackHttp === true,
      bearerToken: definition.bearerTokenEnvironment
        ? requireEnvironmentSecret(environment, definition.bearerTokenEnvironment)
        : undefined,
      fetch: fetchImpl,
      now: () => currentDate(now),
    }),
  }));
  prepareDataDirectory(dataDirectory, { readOnly });
  preflightStoredSecrets({ environment: preparedEnvironment, dataDirectory, readOnly });
  const store = createSqliteStore({ filename: databaseFile, readOnly });
  const core = createReminderCore({ store, delivery, clock: now, policy: config.policy, readOnly });

  let workerPromise = null;
  async function workerOnce() {
    if (workerPromise) return workerPromise;
    workerPromise = core.execute({ kind: 'deliver-pending', limit: config.workerBatchSize })
      .finally(() => { workerPromise = null; });
    return workerPromise;
  }
  const handleScheduledObservation = createScheduledObservationHandler({
    core,
    workerOnce,
    onWorkerError: (error) => process.stderr.write(`delivery worker failed: ${safeMessage(error)}\n`),
  });

  let secrets;
  let serverConfig;
  let schedulers;
  let server;
  try {
    if (!readOnly) await bootstrapRecipients(core, config.recipients);
    secrets = resolveLocalSecrets({ environment: preparedEnvironment, dataDirectory, allowCreate: !readOnly });
    const effectiveEnvironment = { ...preparedEnvironment, ...secrets.environment };
    serverConfig = configFromEnvironment(effectiveEnvironment);
    schedulers = preparedSources.map(({ definition, source }) => {
      return createPollScheduler({
        broadcasterId: definition.broadcasterId,
        statusSource: source,
        pollIntervalMs: definition.pollIntervalMs,
        confirmationIntervalMs: definition.confirmationIntervalMs,
        now: () => currentDate(now),
        onObservation: handleScheduledObservation,
        onError: (error) => {
          process.stderr.write(`status source ${definition.id} failed: ${safeMessage(error)}\n`);
        },
      });
    });
    server = createSelfHostedServer({ staticDir, core, config: serverConfig });
  } catch (error) {
    await core.close();
    throw error;
  }
  let workerHandle;
  let started = false;

  async function start() {
    if (started) throw new Error('self-hosted runtime is already started');
    started = true;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(serverConfig.port, serverConfig.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      started = false;
      throw error;
    }
    if (!readOnly) {
      workerHandle = setIntervalFn(() => {
        workerOnce().catch((error) => process.stderr.write(`delivery worker failed: ${safeMessage(error)}\n`));
      }, workerIntervalMs);
      workerHandle?.unref?.();
      for (const scheduler of schedulers) scheduler.start();
      workerOnce().catch((error) => process.stderr.write(`delivery worker failed: ${safeMessage(error)}\n`));
    }
    return server.address();
  }

  async function stop() {
    for (const scheduler of schedulers) scheduler.stop();
    if (workerHandle !== undefined) {
      clearIntervalFn(workerHandle);
      workerHandle = undefined;
    }
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await workerPromise?.catch(() => {});
    await core.close();
    started = false;
  }

  return Object.freeze({
    config,
    core,
    databaseFile,
    delivery,
    firstRunPassword: secrets.firstRunPassword,
    readOnly,
    server,
    start,
    stop,
    workerOnce,
  });
}

function createDelivery({ environment, fetchImpl }) {
  const mode = String(environment.DELIVERY_MODE || 'local-inbox').trim().toLowerCase();
  if (mode === 'local-inbox') return createLocalInboxDelivery();
  if (mode !== 'webhook') throw new Error('DELIVERY_MODE must be local-inbox or webhook');
  const headers = {};
  if (environment.DELIVERY_WEBHOOK_BEARER_TOKEN) {
    headers.authorization = `Bearer ${environment.DELIVERY_WEBHOOK_BEARER_TOKEN}`;
  }
  return createWebhookDelivery({
    url: environment.DELIVERY_WEBHOOK_URL,
    timeoutMs: Number(environment.DELIVERY_WEBHOOK_TIMEOUT_MS || 5_000),
    allowInsecureLoopback: environment.DELIVERY_WEBHOOK_ALLOW_LOOPBACK_HTTP === '1',
    headers,
    fetchImpl,
  });
}

function createScheduledObservationHandler({ core, workerOnce, onWorkerError = () => {} }) {
  if (!core || typeof core.execute !== 'function') throw new TypeError('core.execute is required');
  if (typeof workerOnce !== 'function') throw new TypeError('workerOnce must be a function');
  if (typeof onWorkerError !== 'function') throw new TypeError('onWorkerError must be a function');
  return async (observation) => {
    const { commandId: _commandId, ...command } = observation;
    const result = await core.execute({ kind: 'observe', ...command });
    Promise.resolve()
      .then(workerOnce)
      .catch(onWorkerError);
    return result;
  };
}

function loadRuntimeConfig(filename) {
  if (!fs.existsSync(filename)) return normalizeRuntimeConfig({});
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('self-hosted config must be a JSON file no larger than 1 MiB');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch {
    throw new Error(`invalid self-hosted JSON config: ${filename}`);
  }
  return normalizeRuntimeConfig(parsed);
}

function normalizeRuntimeConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('self-hosted config must be an object');
  rejectUnknownKeys(input, ['policy', 'recipients', 'statusSources', 'workerBatchSize'], 'self-hosted config');
  if (Object.hasOwn(input, 'recipients') && !Array.isArray(input.recipients)) {
    throw new Error('recipients must be an array');
  }
  if (Object.hasOwn(input, 'statusSources') && !Array.isArray(input.statusSources)) {
    throw new Error('statusSources must be an array');
  }
  if (Object.hasOwn(input, 'policy') && (!input.policy || typeof input.policy !== 'object' || Array.isArray(input.policy))) {
    throw new Error('policy must be an object');
  }
  if (input.policy) {
    rejectUnknownKeys(
      input.policy,
      ['creditCost', 'defaultDeliveryLimit', 'maxObservationFutureSkewMs'],
      'policy',
    );
  }
  const recipients = (input.recipients || []).map(normalizeRecipient);
  const statusSources = (input.statusSources || []).map(normalizeStatusSource);
  if (recipients.length > 100_000) throw new Error('self-hosted config supports at most 100000 recipients');
  if (statusSources.length > 1_000) throw new Error('self-hosted config supports at most 1000 status sources');
  rejectDuplicateValues(recipients.map((item) => item.id), 'recipient id');
  rejectDuplicateValues(statusSources.map((item) => item.id), 'status source id');
  rejectDuplicateValues(statusSources.map((item) => item.broadcasterId), 'broadcaster status source');
  return Object.freeze({
    policy: input.policy ? { ...input.policy } : {},
    recipients,
    statusSources,
    workerBatchSize: boundedInteger(input.workerBatchSize === undefined ? 100 : input.workerBatchSize, 1, 1_000, 'workerBatchSize'),
  });
}

function normalizeRecipient(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`recipients[${index}] must be an object`);
  rejectUnknownKeys(value, ['id', 'credits', 'enabled', 'subscriptions'], `recipients[${index}]`);
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new Error(`recipients[${index}].enabled must be a boolean`);
  }
  if (value.subscriptions !== undefined && !Array.isArray(value.subscriptions)) {
    throw new Error(`recipients[${index}].subscriptions must be an array`);
  }
  return Object.freeze({
    id: boundedString(value.id, 200, `recipients[${index}].id`),
    credits: nonNegativeInteger(value.credits === undefined ? 0 : value.credits, `recipients[${index}].credits`),
    enabled: value.enabled === undefined ? true : value.enabled,
    subscriptions: value.subscriptions
      ? [...new Set(value.subscriptions.map((item) => boundedString(item, 200, `recipients[${index}].subscriptions`)))]
      : [],
  });
}

function normalizeStatusSource(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`statusSources[${index}] must be an object`);
  rejectUnknownKeys(value, [
    'id',
    'broadcasterId',
    'url',
    'allowLoopbackHttp',
    'bearerTokenEnvironment',
    'timeoutMs',
    'pollIntervalMs',
    'confirmationIntervalMs',
  ], `statusSources[${index}]`);
  if (value.allowLoopbackHttp !== undefined && typeof value.allowLoopbackHttp !== 'boolean') {
    throw new Error(`statusSources[${index}].allowLoopbackHttp must be a boolean`);
  }
  if (value.bearerTokenEnvironment !== undefined && !/^[A-Z_][A-Z0-9_]{0,100}$/.test(value.bearerTokenEnvironment)) {
    throw new Error(`statusSources[${index}].bearerTokenEnvironment must name an environment variable`);
  }
  return Object.freeze({
    id: boundedString(value.id, 200, `statusSources[${index}].id`),
    broadcasterId: boundedString(value.broadcasterId, 200, `statusSources[${index}].broadcasterId`),
    url: boundedString(value.url, 2_048, `statusSources[${index}].url`),
    allowLoopbackHttp: value.allowLoopbackHttp === true,
    bearerTokenEnvironment: value.bearerTokenEnvironment,
    timeoutMs: optionalBoundedInteger(value.timeoutMs, 5_000, 1, MAX_TIMER_MS, `statusSources[${index}].timeoutMs`),
    pollIntervalMs: optionalBoundedInteger(value.pollIntervalMs, 120_000, 1, MAX_TIMER_MS, `statusSources[${index}].pollIntervalMs`),
    confirmationIntervalMs: optionalBoundedInteger(value.confirmationIntervalMs, 10_000, 1, MAX_TIMER_MS, `statusSources[${index}].confirmationIntervalMs`),
  });
}

async function bootstrapRecipients(core, recipients) {
  for (const recipient of recipients) {
    await core.execute({
      kind: 'register-recipient',
      recipientId: recipient.id,
      credits: recipient.credits,
      enabled: recipient.enabled,
    });
    for (const broadcasterId of recipient.subscriptions) {
      await core.execute({ kind: 'subscribe', recipientId: recipient.id, broadcasterId, active: true });
    }
  }
}

function resolveLocalSecrets({ environment, dataDirectory, allowCreate = true }) {
  const supplied = SERVER_SECRET_NAMES.filter((name) => String(environment[name] || '').trim() !== '');
  if (supplied.length > 0 && supplied.length !== SERVER_SECRET_NAMES.length) {
    throw new Error(`provide all local secrets together: ${SERVER_SECRET_NAMES.join(', ')}`);
  }
  if (supplied.length === SERVER_SECRET_NAMES.length) return { environment: {}, firstRunPassword: null };
  if (String(environment.SELF_HOSTED_ALLOW_REMOTE || '') === '1') {
    throw new Error(`remote self-hosting requires explicit ${SERVER_SECRET_NAMES.join(', ')}`);
  }
  const filename = path.join(dataDirectory, 'local-secrets.json');
  if (fs.existsSync(filename)) {
    const stored = readStoredSecrets(filename);
    if (allowCreate) protectPath(filename, 0o600);
    return { environment: stored, firstRunPassword: null };
  }
  if (!allowCreate) {
    throw new Error('read-only mode requires existing local secrets or explicit server secrets');
  }
  const password = `reminder-${crypto.randomBytes(18).toString('base64url')}`;
  const stored = {
    ADMIN_PASSWORD_HASH: hashAdminPassword(password),
    ADMIN_SESSION_SECRET: crypto.randomBytes(36).toString('base64url'),
    OBSERVATION_SECRET: crypto.randomBytes(36).toString('base64url'),
    OPERATOR_SECRET: crypto.randomBytes(36).toString('base64url'),
  };
  fs.writeFileSync(filename, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { environment: stored, firstRunPassword: password };
}

function preflightStoredSecrets({ environment, dataDirectory, readOnly }) {
  const supplied = SERVER_SECRET_NAMES.filter((name) => String(environment[name] || '').trim() !== '');
  if (supplied.length === SERVER_SECRET_NAMES.length) return;
  const filename = path.join(dataDirectory, 'local-secrets.json');
  if (!fs.existsSync(filename)) {
    if (readOnly) throw new Error('read-only mode requires existing local secrets or explicit server secrets');
    return;
  }
  const stored = readStoredSecrets(filename);
  try {
    preflightServerEnvironment({ ...environment, ...stored });
  } catch {
    throw new Error('stored local secrets are invalid');
  }
}

function readStoredSecrets(filename) {
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64 * 1024) {
    throw new Error('stored local secrets file is invalid');
  }
  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch {
    throw new Error('stored local secrets file is invalid');
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    throw new Error('stored local secrets are invalid');
  }
  rejectUnknownKeys(stored, SERVER_SECRET_NAMES, 'stored local secrets');
  for (const name of SERVER_SECRET_NAMES) {
    if (typeof stored[name] !== 'string' || stored[name].length < 16) {
      throw new Error('stored local secrets are invalid');
    }
  }
  return stored;
}

function protectPath(target, mode) {
  if (process.platform !== 'win32') fs.chmodSync(target, mode);
}

function preflightServerEnvironment(environment) {
  const supplied = SERVER_SECRET_NAMES.filter((name) => String(environment[name] || '').trim() !== '');
  if (supplied.length > 0 && supplied.length !== SERVER_SECRET_NAMES.length) {
    throw new Error(`provide all local secrets together: ${SERVER_SECRET_NAMES.join(', ')}`);
  }
  if (supplied.length === 0 && String(environment.SELF_HOSTED_ALLOW_REMOTE || '') === '1') {
    throw new Error(`remote self-hosting requires explicit ${SERVER_SECRET_NAMES.join(', ')}`);
  }
  const candidate = configFromEnvironment({
    ...environment,
    ADMIN_PASSWORD_HASH: String(environment.ADMIN_PASSWORD_HASH || '').trim()
      || hashAdminPassword('preflight-password-only', 'preflight-fixed-salt'),
    ADMIN_SESSION_SECRET: String(environment.ADMIN_SESSION_SECRET || '').trim() || 's'.repeat(32),
    OBSERVATION_SECRET: String(environment.OBSERVATION_SECRET || '').trim() || 'b'.repeat(32),
    OPERATOR_SECRET: String(environment.OPERATOR_SECRET || '').trim() || 'o'.repeat(32),
  });
  createSelfHostedServer({
    staticDir: '.',
    config: candidate,
    core: {
      async execute() {},
      async read() { return { summary: {}, broadcasters: [], events: [] }; },
    },
  });
  return candidate;
}

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function boundedString(value, maximumLength, name) {
  const normalized = nonEmptyString(value, name);
  if (normalized.length > maximumLength) throw new Error(`${name} must be at most ${maximumLength} characters`);
  return normalized;
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function boundedInteger(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function optionalBoundedInteger(value, fallback, minimum, maximum, name) {
  return value === undefined ? fallback : boundedInteger(value, minimum, maximum, name);
}

function rejectDuplicateValues(values, name) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${name}: ${value}`);
    seen.add(value);
  }
}

function rejectUnknownKeys(value, allowedKeys, name) {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${name} contains unknown field: ${unknown}`);
}

function resolveDatabaseFilename(dataDirectory, configuredValue) {
  const filename = String(configuredValue || 'live-reminder.sqlite').trim();
  if (!filename || path.isAbsolute(filename) || path.basename(filename) !== filename || filename === '.' || filename === '..') {
    throw new Error('SELF_HOSTED_DATABASE must be a filename inside SELF_HOSTED_DATA_DIR');
  }
  return path.join(dataDirectory, filename);
}

function validateDataDirectory(dataDirectory, workingDirectory) {
  if (dataDirectory === workingDirectory || dataDirectory === path.parse(dataDirectory).root) {
    throw new Error('SELF_HOSTED_DATA_DIR must be a dedicated subdirectory, not the project or filesystem root');
  }
}

function prepareDataDirectory(dataDirectory, { readOnly }) {
  if (!fs.existsSync(dataDirectory)) {
    if (readOnly) throw new Error('read-only mode requires an existing data directory');
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    protectPath(dataDirectory, 0o700);
    return;
  }
  const stat = fs.lstatSync(dataDirectory);
  if (stat.isSymbolicLink()) throw new Error('data directory must not be a symbolic link');
  if (!stat.isDirectory()) throw new Error('SELF_HOSTED_DATA_DIR must identify a directory');
  if (!readOnly && process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('existing SELF_HOSTED_DATA_DIR must be owner-only (mode 0700)');
  }
}

function requireEnvironmentSecret(environment, name) {
  const value = String(environment[name] || '').trim();
  if (!value) throw new Error(`missing status-source secret environment variable: ${name}`);
  return value;
}

function currentDate(clock) {
  const value = typeof clock === 'function' ? clock() : clock.now();
  return value instanceof Date ? value : new Date(value);
}

function safeMessage(error) {
  return error && typeof error.message === 'string' ? error.message.slice(0, 500) : 'unknown error';
}

function isLoopbackHost(host) {
  const normalized = String(host || '').trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || normalized === '[::1]';
}

async function main() {
  let runtime;
  try {
    runtime = await createSelfHostedRuntime();
    if (runtime.firstRunPassword) {
      process.stdout.write(`First-run administrator password: ${runtime.firstRunPassword}\n`);
      process.stdout.write('Save it now. It will not be printed again.\n');
    }
    const address = await runtime.start();
    process.stdout.write(`Live Reminder Platform: http://${address.address}:${address.port}/admin\n`);
  } catch (error) {
    await runtime?.stop().catch(() => {});
    throw error;
  }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await runtime.stop();
  };
  process.once('SIGINT', () => stop().finally(() => { process.exitCode = 130; }));
  process.once('SIGTERM', () => stop().finally(() => { process.exitCode = 143; }));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${safeMessage(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  createScheduledObservationHandler,
  createSelfHostedRuntime,
  loadRuntimeConfig,
  normalizeRuntimeConfig,
  resolveLocalSecrets,
};
