'use strict';

const { createEmptyState } = require('../../core/reminder-core.cjs');

function createMemoryStore({ initialState } = {}) {
  let state = structuredClone(initialState ?? createEmptyState());
  let queue = Promise.resolve();
  let closed = false;

  function transact(callback) {
    assertUsable(callback);
    return enqueue(() => {
      const draft = structuredClone(state);
      const result = callback(draft);
      rejectAsyncCallback(result);
      state = draft;
      return structuredClone(result);
    });
  }

  function read(callback) {
    assertUsable(callback);
    return enqueue(() => {
      const result = callback(structuredClone(state));
      rejectAsyncCallback(result);
      return structuredClone(result);
    });
  }

  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function close() {
    if (closed) return;
    closed = true;
    await queue;
  }

  function assertUsable(callback) {
    if (closed) throw new Error('memory store is closed');
    if (typeof callback !== 'function') throw new TypeError('store callback must be a function');
  }

  return Object.freeze({ transact, read, close });
}

function rejectAsyncCallback(result) {
  if (result && typeof result.then === 'function') {
    throw new TypeError('store callbacks must be synchronous; external I/O is not allowed in a transaction');
  }
}

module.exports = { createMemoryStore };
