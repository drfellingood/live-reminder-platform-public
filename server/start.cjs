'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const { createReminderCore } = require('../core/reminder-core.cjs');
const { createLocalInboxDelivery } = require('../adapters/delivery/local-inbox.cjs');
const { createWebhookDelivery } = require('../adapters/delivery/webhook.cjs');
const { createWechatSubscribeDelivery } = require('../adapters/delivery/wechat-subscribe.cjs');
const { createWechatMiniProgramIdentity } = require('../adapters/identity/wechat-mini-program.cjs');
const { createSqliteClientStore } = require('../adapters/storage/sqlite-client-store.cjs');
const { createSqliteStore } = require('../adapters/storage/sqlite-store.cjs');
const { createPlaywrightCdpDouyinDriver } = require('../sources/playwright-cdp-douyin-driver.cjs');
const { createPollScheduler } = require('../sources/poll-scheduler.cjs');
const { createStatusSourceRuntime } = require('../sources/status-source-runtime.cjs');
const { hashAdminPassword } = require('./admin-server.cjs');
const { createClientPortal } = require('./client-portal.cjs');
const { createClientRequestHandler } = require('./client-routes.cjs');
const {
  configFromEnvironment,
  createSelfHostedServer,
} = require('./self-hosted-server.cjs');

const DEFAULT_DATA_DIRECTORY = '.data';
const DEFAULT_CONFIG_FILE = 'config/self-hosted.json';
const DEFAULT_WORKER_INTERVAL_MS = 1_000;
const MAX_TIMER_MS = 2_147_483_647;
const CLIENT_TEMPLATE_SOURCES = new Set(['broadcasterId', 'eventId', 'occurredAt', 'source']);
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
  createBrowserDriver = createPlaywrightCdpDouyinDriver,
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
  const serverPreflightConfig = preflightServerEnvironment(preparedEnvironment);
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
  const clientActive = config.client.enabled && !readOnly;
  const deliveryMode = String(environment.DELIVERY_MODE || 'local-inbox').trim().toLowerCase();
  if (clientActive && deliveryMode !== 'wechat-subscribe') {
    throw new Error('client.enabled requires DELIVERY_MODE=wechat-subscribe');
  }
  const clientEnvironment = clientActive ? resolveClientEnvironment(environment) : null;
  const clientDatabaseFile = clientActive
    ? resolveDatabaseFilename(
      dataDirectory,
      environment.SELF_HOSTED_CLIENT_DATABASE,
      'client-portal.sqlite',
      'SELF_HOSTED_CLIENT_DATABASE',
    )
    : null;
  const sourceDefinitions = (readOnly ? [] : config.statusSources).map((definition) => {
    if (definition.kind !== 'http-json' || !definition.bearerTokenEnvironment) return definition;
    return Object.freeze({
      ...definition,
      bearerToken: requireEnvironmentSecret(environment, definition.bearerTokenEnvironment),
    });
  });
  const browserOptions = sourceDefinitions.some(definition => definition.kind === 'douyin-page')
    ? resolveBrowserOptions(config.browser, environment)
    : undefined;
  const statusSourceRuntime = createStatusSourceRuntime({
    definitions: sourceDefinitions,
    browser: browserOptions,
    createBrowserDriver,
    fetch: fetchImpl,
    now: () => currentDate(now),
  });
  const preparedSources = statusSourceRuntime.registrations;
  await assertPortAvailable(serverPreflightConfig.host, serverPreflightConfig.port);
  prepareDataDirectory(dataDirectory, { readOnly });
  const runtimeLock = readOnly ? null : acquireRuntimeLock(dataDirectory);
  let clientStore;
  let core;
  let delivery;
  try {
    preflightStoredSecrets({ environment: preparedEnvironment, dataDirectory, readOnly });
    clientStore = clientActive
      ? createSqliteClientStore({
        filename: clientDatabaseFile,
        identitySecret: clientEnvironment.identitySecret,
        sessionTtlMs: config.client.sessionTtlMs,
        maxSessionsPerIdentity: config.client.maxSessionsPerIdentity,
        now: () => currentDate(now).getTime(),
      })
      : null;
    if (clientStore) clientStore.verifyTemplateBinding(clientEnvironment.templateId);
    delivery = readOnly
      ? createLocalInboxDelivery()
      : createDelivery({
        environment,
        fetchImpl,
        clientStore,
        clientEnvironment,
        clientConfig: config.client,
        clock: now,
      });
    const store = createSqliteStore({ filename: databaseFile, readOnly });
    core = createReminderCore({ store, delivery, clock: now, policy: config.policy, readOnly });
  } catch (error) {
    await statusSourceRuntime.close().catch(() => {});
    clientStore?.close();
    runtimeLock?.release();
    throw error;
  }

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
    let clientRequestHandler;
    if (clientActive) {
      const identity = createWechatMiniProgramIdentity({
        appId: clientEnvironment.appId,
        appSecret: clientEnvironment.appSecret,
        fetchImpl,
        timeoutMs: clientEnvironment.timeoutMs,
      });
      const publicChannels = config.channels
        .filter(channel => channel.enabled)
        .map(channel => ({
          channelId: channel.id,
          broadcasterId: channel.id,
          name: channel.displayName,
          sourceLabel: channel.platform,
          description: channel.description,
          staleAfterMs: channel.staleAfterMs,
        }));
      const portal = createClientPortal({
        core,
        identity,
        store: clientStore,
        publicChannels,
        templateId: clientEnvironment.templateId,
        grantIntentTtlMs: config.client.grantIntentTtlMs,
        maxCredits: config.client.maxCredits,
        now: () => currentDate(now).getTime(),
      });
      clientRequestHandler = createClientRequestHandler({ portal });
    }
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
    server = createSelfHostedServer({
      staticDir,
      core,
      config: serverConfig,
      clientRequestHandler,
    });
  } catch (error) {
    await statusSourceRuntime.close().catch(() => {});
    await core.close();
    clientStore?.close();
    runtimeLock?.release();
    throw error;
  }
  let workerHandle;
  let started = false;

  async function start() {
    if (started) throw new Error('self-hosted runtime is already started');
    started = true;
    try {
      await statusSourceRuntime.start();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(serverConfig.port, serverConfig.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      started = false;
      await statusSourceRuntime.close().catch(() => {});
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
    await Promise.all(schedulers.map(scheduler => scheduler.stop().catch(() => {})));
    if (workerHandle !== undefined) {
      clearIntervalFn(workerHandle);
      workerHandle = undefined;
    }
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await workerPromise?.catch(() => {});
    await statusSourceRuntime.close();
    await core.close();
    clientStore?.close();
    runtimeLock?.release();
    started = false;
  }

  return Object.freeze({
    config,
    clientDatabaseFile,
    clientEnabled: clientActive,
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

function createDelivery({
  environment,
  fetchImpl,
  clientStore,
  clientEnvironment,
  clientConfig,
  clock,
}) {
  const mode = String(environment.DELIVERY_MODE || 'local-inbox').trim().toLowerCase();
  if (mode === 'local-inbox') return createLocalInboxDelivery();
  if (mode === 'wechat-subscribe') {
    if (!clientStore || !clientEnvironment || !clientConfig || !clientConfig.template) {
      throw new Error('DELIVERY_MODE=wechat-subscribe requires client.enabled and complete WeChat client configuration');
    }
    return createWechatSubscribeDelivery({
      appId: clientEnvironment.appId,
      appSecret: clientEnvironment.appSecret,
      template: {
        id: clientEnvironment.templateId,
        ...clientConfig.template,
      },
      resolveOpenId: recipientId => clientStore.resolveProviderSubject({
        provider: 'wechat-mini-program',
        recipientId,
      }),
      fetchImpl,
      timeoutMs: clientEnvironment.timeoutMs,
      clock,
    });
  }
  if (mode !== 'webhook') {
    throw new Error('DELIVERY_MODE must be local-inbox, webhook, or wechat-subscribe');
  }
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

function resolveClientEnvironment(environment) {
  const appId = requireClientEnvironmentSecret(environment, 'WECHAT_MINIPROGRAM_APP_ID', 128);
  const appSecret = requireClientEnvironmentSecret(environment, 'WECHAT_MINIPROGRAM_APP_SECRET', 256);
  const templateId = requireClientEnvironmentSecret(environment, 'WECHAT_MINIPROGRAM_TEMPLATE_ID', 256);
  const identitySecret = requireClientEnvironmentSecret(environment, 'CLIENT_IDENTITY_SECRET', 1_024);
  if (identitySecret.length < 32) throw new Error('CLIENT_IDENTITY_SECRET must be at least 32 characters');
  return Object.freeze({
    appId,
    appSecret,
    templateId,
    identitySecret,
    timeoutMs: boundedInteger(
      Number(environment.WECHAT_API_TIMEOUT_MS || 5_000),
      1,
      MAX_TIMER_MS,
      'WECHAT_API_TIMEOUT_MS',
    ),
  });
}

function requireClientEnvironmentSecret(environment, name, maximumLength) {
  const value = String(environment[name] || '').trim();
  if (!value) throw new Error(`missing client environment variable: ${name}`);
  if (value.length > maximumLength) throw new Error(`${name} must be at most ${maximumLength} characters`);
  if (/\r|\n/.test(value)) throw new Error(`${name} must be a single line`);
  return value;
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
  rejectUnknownKeys(input, ['policy', 'recipients', 'statusSources', 'workerBatchSize', 'client', 'channels', 'browser'], 'self-hosted config');
  if (Object.hasOwn(input, 'recipients') && !Array.isArray(input.recipients)) {
    throw new Error('recipients must be an array');
  }
  if (Object.hasOwn(input, 'statusSources') && !Array.isArray(input.statusSources)) {
    throw new Error('statusSources must be an array');
  }
  if (Object.hasOwn(input, 'channels') && !Array.isArray(input.channels)) {
    throw new Error('channels must be an array');
  }
  if (Object.hasOwn(input, 'policy') && (!input.policy || typeof input.policy !== 'object' || Array.isArray(input.policy))) {
    throw new Error('policy must be an object');
  }
  if (input.policy) {
    rejectUnknownKeys(
      input.policy,
      [
        'creditCost',
        'defaultDeliveryLimit',
        'deliveryConcurrency',
        'deliveryDeadlineMs',
        'deliveryRetryDelayMs',
        'maxObservationFutureSkewMs',
      ],
      'policy',
    );
  }
  const recipients = (input.recipients || []).map(normalizeRecipient);
  const statusSources = (input.statusSources || []).map(normalizeStatusSource);
  const browser = normalizeBrowserConfig(input.browser);
  if (statusSources.some(source => source.kind === 'douyin-page') && !browser) {
    throw new Error('browser configuration is required for douyin-page status sources');
  }
  validateBrowserPollingCapacity(statusSources, browser);
  const client = normalizeClientConfig(input.client);
  const channels = (input.channels || []).map(normalizePublicChannel)
    .sort((left, right) => left.sort - right.sort || left.id.localeCompare(right.id));
  if (recipients.length > 100_000) throw new Error('self-hosted config supports at most 100000 recipients');
  if (statusSources.length > 1_000) throw new Error('self-hosted config supports at most 1000 status sources');
  if (channels.length > 1_000) throw new Error('self-hosted config supports at most 1000 public channels');
  rejectDuplicateValues(recipients.map((item) => item.id), 'recipient id');
  rejectDuplicateValues(statusSources.map((item) => item.id), 'status source id');
  rejectDuplicateValues(statusSources.map((item) => item.broadcasterId), 'broadcaster status source');
  rejectDuplicateValues(channels.map((item) => item.id), 'public channel id');
  return Object.freeze({
    policy: input.policy ? { ...input.policy } : {},
    recipients,
    statusSources,
    browser,
    client,
    channels,
    workerBatchSize: boundedInteger(input.workerBatchSize === undefined ? 100 : input.workerBatchSize, 1, 1_000, 'workerBatchSize'),
  });
}

function normalizeClientConfig(value) {
  if (value === undefined) {
    return Object.freeze({
      enabled: false,
      sessionTtlMs: 2_592_000_000,
      maxSessionsPerIdentity: 5,
      grantIntentTtlMs: 300_000,
      maxCredits: 200,
      template: null,
    });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('client must be an object');
  rejectUnknownKeys(
    value,
    ['enabled', 'sessionTtlMs', 'maxSessionsPerIdentity', 'grantIntentTtlMs', 'maxCredits', 'template'],
    'client',
  );
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new Error('client.enabled must be a boolean');
  }
  const enabled = value.enabled === true;
  if (enabled && value.template === undefined) throw new Error('client.template is required when client.enabled is true');
  return Object.freeze({
    enabled,
    sessionTtlMs: optionalBoundedInteger(value.sessionTtlMs, 2_592_000_000, 60_000, 7_776_000_000, 'client.sessionTtlMs'),
    maxSessionsPerIdentity: optionalBoundedInteger(value.maxSessionsPerIdentity, 5, 1, 20, 'client.maxSessionsPerIdentity'),
    grantIntentTtlMs: optionalBoundedInteger(value.grantIntentTtlMs, 300_000, 30_000, 900_000, 'client.grantIntentTtlMs'),
    maxCredits: optionalBoundedInteger(value.maxCredits, 200, 1, 10_000, 'client.maxCredits'),
    template: value.template === undefined ? null : normalizeClientTemplate(value.template),
  });
}

function normalizeClientTemplate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('client.template must be an object');
  rejectUnknownKeys(value, ['page', 'state', 'language', 'fields'], 'client.template');
  const page = boundedString(value.page, 256, 'client.template.page');
  if (page.startsWith('/') || page.includes('..') || /:\/\//.test(page)) {
    throw new Error('client.template.page must be a relative mini-program page');
  }
  const state = value.state === undefined ? 'formal' : String(value.state);
  if (!['developer', 'trial', 'formal'].includes(state)) {
    throw new Error('client.template.state must be developer, trial, or formal');
  }
  const language = value.language === undefined ? 'zh_CN' : String(value.language);
  if (!['zh_CN', 'en_US', 'zh_HK', 'zh_TW'].includes(language)) {
    throw new Error('client.template.language is not supported');
  }
  if (!value.fields || typeof value.fields !== 'object' || Array.isArray(value.fields)) {
    throw new Error('client.template.fields must be an object');
  }
  const entries = Object.entries(value.fields);
  if (entries.length < 1 || entries.length > 10) throw new Error('client.template.fields must contain 1 to 10 fields');
  const fields = {};
  for (const [key, definition] of entries) {
    if (!/^[a-z][a-z0-9_]{0,31}$/i.test(key)) throw new Error(`client.template field key is invalid: ${key}`);
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new Error(`client.template.fields.${key} must be an object`);
    }
    rejectUnknownKeys(definition, ['source', 'maxLength'], `client.template.fields.${key}`);
    const source = String(definition.source || '');
    if (!CLIENT_TEMPLATE_SOURCES.has(source)) {
      throw new Error(`client.template.fields.${key}.source is not supported`);
    }
    fields[key] = Object.freeze({
      source,
      maxLength: optionalBoundedInteger(
        definition.maxLength,
        100,
        1,
        200,
        `client.template.fields.${key}.maxLength`,
      ),
    });
  }
  return Object.freeze({ page, state, language, fields: Object.freeze(fields) });
}

function normalizePublicChannel(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`channels[${index}] must be an object`);
  rejectUnknownKeys(
    value,
    ['id', 'displayName', 'platform', 'description', 'enabled', 'sort', 'staleAfterMs'],
    `channels[${index}]`,
  );
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new Error(`channels[${index}].enabled must be a boolean`);
  }
  const id = boundedString(value.id, 200, `channels[${index}].id`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id)) {
    throw new Error(`channels[${index}].id must be URL-path safe`);
  }
  return Object.freeze({
    id,
    displayName: boundedString(value.displayName, 100, `channels[${index}].displayName`),
    platform: value.platform === undefined ? '' : boundedString(value.platform, 80, `channels[${index}].platform`),
    description: value.description === undefined ? '' : boundedString(value.description, 300, `channels[${index}].description`),
    enabled: value.enabled === undefined ? true : value.enabled,
    sort: optionalBoundedInteger(value.sort, index, -10_000, 10_000, `channels[${index}].sort`),
    staleAfterMs: optionalBoundedInteger(value.staleAfterMs, 360_000, 10_000, MAX_TIMER_MS, `channels[${index}].staleAfterMs`),
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
  const kind = value.kind === undefined ? 'http-json' : String(value.kind);
  if (!['http-json', 'douyin-page'].includes(kind)) {
    throw new Error(`statusSources[${index}].kind must be http-json or douyin-page`);
  }
  const commonKeys = [
    'kind', 'id', 'broadcasterId', 'url', 'timeoutMs', 'pollIntervalMs', 'confirmationIntervalMs',
  ];
  rejectUnknownKeys(
    value,
    kind === 'http-json'
      ? [...commonKeys, 'allowLoopbackHttp', 'bearerTokenEnvironment']
      : [...commonKeys, 'expectedIdentity'],
    `statusSources[${index}]`,
  );
  if (value.allowLoopbackHttp !== undefined && typeof value.allowLoopbackHttp !== 'boolean') {
    throw new Error(`statusSources[${index}].allowLoopbackHttp must be a boolean`);
  }
  if (value.bearerTokenEnvironment !== undefined && !/^[A-Z_][A-Z0-9_]{0,100}$/.test(value.bearerTokenEnvironment)) {
    throw new Error(`statusSources[${index}].bearerTokenEnvironment must name an environment variable`);
  }
  const isDouyinPage = kind === 'douyin-page';
  const normalized = {
    kind,
    id: boundedString(value.id, 200, `statusSources[${index}].id`),
    broadcasterId: boundedString(value.broadcasterId, 200, `statusSources[${index}].broadcasterId`),
    url: boundedString(value.url, 2_048, `statusSources[${index}].url`),
    timeoutMs: optionalBoundedInteger(
      value.timeoutMs,
      isDouyinPage ? 30_000 : 5_000,
      isDouyinPage ? 1_000 : 1,
      isDouyinPage ? 90_000 : MAX_TIMER_MS,
      `statusSources[${index}].timeoutMs`,
    ),
    pollIntervalMs: optionalBoundedInteger(
      value.pollIntervalMs,
      120_000,
      isDouyinPage ? 60_000 : 1,
      MAX_TIMER_MS,
      `statusSources[${index}].pollIntervalMs`,
    ),
    confirmationIntervalMs: optionalBoundedInteger(
      value.confirmationIntervalMs,
      10_000,
      isDouyinPage ? 5_000 : 1,
      isDouyinPage ? 300_000 : MAX_TIMER_MS,
      `statusSources[${index}].confirmationIntervalMs`,
    ),
  };
  if (kind === 'http-json') {
    normalized.allowLoopbackHttp = value.allowLoopbackHttp === true;
    normalized.bearerTokenEnvironment = value.bearerTokenEnvironment;
  } else {
    normalized.expectedIdentity = boundedString(
      value.expectedIdentity,
      256,
      `statusSources[${index}].expectedIdentity`,
    );
    const canonicalUrl = `https://www.douyin.com/user/${normalized.expectedIdentity}`;
    if (!/^[A-Za-z0-9._~-]{1,256}$/.test(normalized.expectedIdentity) || normalized.url !== canonicalUrl) {
      throw new Error(`statusSources[${index}] must use a canonical Douyin /user/ URL matching expectedIdentity`);
    }
  }
  return Object.freeze(normalized);
}

function normalizeBrowserConfig(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('browser must be an object');
  }
  rejectUnknownKeys(
    value,
    ['kind', 'endpointEnvironment', 'connectTimeoutMs', 'minimumReadSpacingMs'],
    'browser',
  );
  const kind = value.kind === undefined ? 'chromium-cdp' : String(value.kind);
  if (kind !== 'chromium-cdp') throw new Error('browser.kind must be chromium-cdp');
  const endpointEnvironment = value.endpointEnvironment === undefined
    ? 'STATUS_BROWSER_CDP_ENDPOINT'
    : String(value.endpointEnvironment);
  if (!/^[A-Z_][A-Z0-9_]{0,100}$/.test(endpointEnvironment)) {
    throw new Error('browser.endpointEnvironment must name an environment variable');
  }
  return Object.freeze({
    kind,
    endpointEnvironment,
    connectTimeoutMs: optionalBoundedInteger(
      value.connectTimeoutMs,
      10_000,
      1,
      MAX_TIMER_MS,
      'browser.connectTimeoutMs',
    ),
    minimumReadSpacingMs: optionalBoundedInteger(
      value.minimumReadSpacingMs,
      12_000,
      10_000,
      MAX_TIMER_MS,
      'browser.minimumReadSpacingMs',
    ),
  });
}

function validateBrowserPollingCapacity(statusSources, browser) {
  const pageSources = statusSources.filter(source => source.kind === 'douyin-page');
  if (pageSources.length === 0) return;
  const possibleReadsPerCycle = pageSources.length * 2;
  // Each source read has one end-to-end timeout; a transition needs two reads.
  const worstCaseBatchMs = pageSources.reduce((total, source) => total + source.timeoutMs * 2, 0)
    + browser.minimumReadSpacingMs * Math.max(0, possibleReadsPerCycle - 1)
    + Math.max(...pageSources.map(source => source.confirmationIntervalMs));
  const shortestPollIntervalMs = Math.min(...pageSources.map(source => source.pollIntervalMs));
  if (worstCaseBatchMs > shortestPollIntervalMs) {
    throw new Error(
      'browser polling capacity is insufficient: reduce targets/timeouts/spacing or increase poll intervals',
    );
  }
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

async function assertPortAvailable(host, port) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    const rejectUnavailable = (cause) => {
      const error = new Error(`self-hosted listener ${host}:${port} is unavailable: ${safeMessage(cause)}`);
      error.code = cause && cause.code;
      reject(error);
    };
    probe.once('error', rejectUnavailable);
    probe.listen(port, host, () => {
      probe.off('error', rejectUnavailable);
      probe.close((error) => error ? rejectUnavailable(error) : resolve());
    });
  });
}

function acquireRuntimeLock(dataDirectory) {
  const filename = path.join(dataDirectory, 'runtime.lock');
  const token = crypto.randomBytes(24).toString('base64url');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = fs.openSync(filename, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({
        pid: process.pid,
        token,
        startedAt: new Date().toISOString(),
      }), { encoding: 'utf8' });
      fs.fsyncSync(descriptor);
      protectPath(filename, 0o600);
      let released = false;
      return Object.freeze({
        release() {
          if (released) return;
          released = true;
          try {
            fs.closeSync(descriptor);
          } finally {
            try {
              const current = JSON.parse(fs.readFileSync(filename, 'utf8'));
              if (current && current.token === token) fs.unlinkSync(filename);
            } catch {
              // Never delete a lock whose ownership can no longer be proven.
            }
          }
        },
      });
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
      if (error && error.code === 'EEXIST') {
        const owner = readRuntimeLockOwner(filename);
        if (owner && isProcessAlive(owner.pid)) {
          const conflict = new Error(`another writable runtime already owns ${dataDirectory}`);
          conflict.code = 'RUNTIME_ALREADY_ACTIVE';
          throw conflict;
        }
        if (!owner) {
          const invalid = new Error(`runtime lock is invalid; verify no process is using ${dataDirectory} before removing ${filename}`);
          invalid.code = 'RUNTIME_LOCK_INVALID';
          throw invalid;
        }
        try {
          fs.unlinkSync(filename);
        } catch (unlinkError) {
          const conflict = new Error(`runtime lock could not be reclaimed: ${safeMessage(unlinkError)}`);
          conflict.code = 'RUNTIME_ALREADY_ACTIVE';
          throw conflict;
        }
        continue;
      }
      throw error;
    }
  }
  const error = new Error(`unable to acquire runtime lock for ${dataDirectory}`);
  error.code = 'RUNTIME_ALREADY_ACTIVE';
  throw error;
}

function readRuntimeLockOwner(filename) {
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_096) return null;
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!value || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.token !== 'string') return null;
    return value;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
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

function resolveDatabaseFilename(
  dataDirectory,
  configuredValue,
  fallback = 'live-reminder.sqlite',
  environmentName = 'SELF_HOSTED_DATABASE',
) {
  const filename = String(configuredValue || fallback).trim();
  if (!filename || path.isAbsolute(filename) || path.basename(filename) !== filename || filename === '.' || filename === '..') {
    throw new Error(`${environmentName} must be a filename inside SELF_HOSTED_DATA_DIR`);
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

function resolveBrowserOptions(browser, environment) {
  if (!browser) throw new Error('browser configuration is required for page status sources');
  const endpoint = String(environment[browser.endpointEnvironment] || '').trim();
  if (!endpoint) {
    throw new Error(`missing browser endpoint environment variable: ${browser.endpointEnvironment}`);
  }
  if (endpoint.length > 2_048 || /\r|\n/.test(endpoint)) {
    throw new Error(`${browser.endpointEnvironment} must be a single endpoint no longer than 2048 characters`);
  }
  return Object.freeze({
    kind: browser.kind,
    endpoint,
    connectTimeoutMs: browser.connectTimeoutMs,
    minimumReadSpacingMs: browser.minimumReadSpacingMs,
  });
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
