'use strict';

const { createDouyinPageStatusSource } = require('./douyin-page-status-source.cjs');
const { createHttpJsonStatusSource } = require('./http-json-status-source.cjs');

function createStatusSourceRuntime(options = {}) {
  const definitions = requireArray(options.definitions, 'definitions');
  for (const [index, definition] of definitions.entries()) {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new TypeError(`definitions[${index}] must be an object`);
    }
    if (!['http-json', 'douyin-page'].includes(definition.kind)) {
      throw new TypeError(`definitions[${index}].kind must be http-json or douyin-page`);
    }
  }
  const now = options.now ?? (() => new Date());
  const pageDefinitions = definitions.filter(definition => definition.kind === 'douyin-page');
  const createBrowserDriver = options.createBrowserDriver;
  let driver = null;
  let started = false;
  let closed = false;

  if (pageDefinitions.length > 0) {
    if (typeof createBrowserDriver !== 'function') {
      throw new TypeError('createBrowserDriver is required for douyin-page sources');
    }
    driver = createBrowserDriver({ ...options.browser, fetch: options.fetch });
    if (!driver || typeof driver.start !== 'function'
      || typeof driver.inspectDouyinPage !== 'function'
      || typeof driver.close !== 'function') {
      throw new TypeError('browser driver must provide start, inspectDouyinPage, and close');
    }
  }

  const registrations = Object.freeze(definitions.map((definition) => {
    const source = definition.kind === 'douyin-page'
      ? createDouyinPageStatusSource({
          id: definition.id,
          url: definition.url,
          expectedIdentity: definition.expectedIdentity,
          timeoutMs: definition.timeoutMs,
          driver,
          now,
        })
      : createHttpJsonStatusSource({
          id: definition.id,
          url: definition.url,
          timeoutMs: definition.timeoutMs,
          allowLoopbackHttp: definition.allowLoopbackHttp === true,
          bearerToken: definition.bearerToken,
          fetch: options.fetch,
          now,
        });
    return Object.freeze({ definition, source });
  }));

  return Object.freeze({
    registrations,
    async start() {
      if (closed) throw new Error('status source runtime is closed');
      if (started) return;
      try {
        if (driver) await driver.start();
        started = true;
      } catch (error) {
        await driver?.close().catch(() => {});
        closed = true;
        throw error;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      if (driver) await driver.close();
      started = false;
    },
  });
}

function requireArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value;
}

module.exports = { createStatusSourceRuntime };
