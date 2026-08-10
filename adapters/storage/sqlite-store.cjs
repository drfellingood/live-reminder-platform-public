'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createEmptyState } = require('../../core/reminder-core.cjs');

function createSqliteStore({ filename, readOnly = false } = {}) {
  if (typeof filename !== 'string' || filename.trim() === '') {
    throw new TypeError('filename must be a non-empty string');
  }
  if (typeof readOnly !== 'boolean') throw new TypeError('readOnly must be a boolean');
  const resolved = filename === ':memory:' ? filename : path.resolve(filename);
  if (readOnly && resolved === ':memory:') throw new Error('read-only SQLite requires an existing file');
  if (resolved !== ':memory:') {
    if (readOnly && !fs.existsSync(resolved)) throw new Error('read-only SQLite file does not exist');
    if (!readOnly) fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  }

  const database = readOnly
    ? new DatabaseSync(resolved, { readOnly: true })
    : new DatabaseSync(resolved);
  if (readOnly) {
    database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;');
  } else {
    database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
    database.exec(`
      CREATE TABLE IF NOT EXISTS reminder_core_state (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        revision INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    database.prepare(`
      INSERT OR IGNORE INTO reminder_core_state (singleton_id, revision, state_json, updated_at)
      VALUES (1, 0, ?, ?)
    `).run(JSON.stringify(createEmptyState()), new Date().toISOString());
    protectDatabaseFiles(resolved);
  }

  const selectState = database.prepare(
    'SELECT revision, state_json FROM reminder_core_state WHERE singleton_id = 1'
  );
  const updateState = database.prepare(`
    UPDATE reminder_core_state
    SET revision = ?, state_json = ?, updated_at = ?
    WHERE singleton_id = 1
  `);
  let queue = Promise.resolve();
  let closed = false;

  function transact(callback) {
    if (readOnly) throw new Error('SQLite store is read-only');
    assertUsable(callback);
    return enqueue(() => {
      database.exec('BEGIN IMMEDIATE');
      try {
        const row = selectState.get();
        const state = parseState(row.state_json);
        const result = callback(state);
        rejectAsyncCallback(result);
        updateState.run(row.revision + 1, JSON.stringify(state), new Date().toISOString());
        database.exec('COMMIT');
        return structuredClone(result);
      } catch (error) {
        try {
          database.exec('ROLLBACK');
        } catch {
          // Preserve the original transaction failure.
        }
        throw error;
      }
    });
  }

  function read(callback) {
    assertUsable(callback);
    return enqueue(() => {
      const row = selectState.get();
      const result = callback(parseState(row.state_json));
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
    database.close();
  }

  function assertUsable(callback) {
    if (closed) throw new Error('SQLite store is closed');
    if (typeof callback !== 'function') throw new TypeError('store callback must be a function');
  }

  return Object.freeze({ transact, read, close, filename: resolved, readOnly });
}

function protectDatabaseFiles(filename) {
  if (filename === ':memory:' || process.platform === 'win32') return;
  for (const candidate of [filename, `${filename}-wal`, `${filename}-shm`]) {
    if (fs.existsSync(candidate)) fs.chmodSync(candidate, 0o600);
  }
}

function parseState(json) {
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('stored reminder state is not an object');
  }
  return parsed;
}

function rejectAsyncCallback(result) {
  if (result && typeof result.then === 'function') {
    throw new TypeError('store callbacks must be synchronous; external I/O is not allowed in a transaction');
  }
}

module.exports = { createSqliteStore };
