'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const COMPLETED_GRANT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function createSqliteClientStore({
  filename,
  identitySecret,
  now = Date.now,
  randomBytes = crypto.randomBytes,
  sessionTtlMs = 30 * 24 * 60 * 60 * 1000,
  maxSessionsPerIdentity = 5,
  maxPendingGrantIntents = 3,
  maxRetainedGrantIntentsPerIdentity = 1_000,
} = {}) {
  if (typeof filename !== 'string' || filename.trim() === '') {
    throw new TypeError('filename must be a non-empty string');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof randomBytes !== 'function') throw new TypeError('randomBytes must be a function');
  if (typeof identitySecret !== 'string' || identitySecret.length < 32) {
    throw new TypeError('identitySecret must be at least 32 characters');
  }
  const identityKey = crypto.createHash('sha256')
    .update('live-reminder-client-identity-v1\0')
    .update(identitySecret)
    .digest();
  const resolvedSessionTtlMs = positiveSafeInteger(sessionTtlMs, 'sessionTtlMs');
  const resolvedMaxSessions = boundedSafeInteger(maxSessionsPerIdentity, 1, 100, 'maxSessionsPerIdentity');
  const resolvedMaxPendingGrantIntents = boundedSafeInteger(
    maxPendingGrantIntents,
    1,
    20,
    'maxPendingGrantIntents',
  );
  const resolvedMaxRetainedGrantIntents = boundedSafeInteger(
    maxRetainedGrantIntentsPerIdentity,
    resolvedMaxPendingGrantIntents,
    10_000,
    'maxRetainedGrantIntentsPerIdentity',
  );

  const resolved = filename === ':memory:' ? filename : path.resolve(filename);
  if (resolved !== ':memory:') {
    fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  }
  const database = new DatabaseSync(resolved);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  database.exec(`
    CREATE TABLE IF NOT EXISTS client_identities (
      provider TEXT NOT NULL,
      subject_hash TEXT NOT NULL,
      subject_ciphertext TEXT,
      subject_nonce TEXT,
      subject_tag TEXT,
      recipient_id TEXT NOT NULL UNIQUE,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (provider, subject_hash)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS client_sessions (
      token_hash TEXT PRIMARY KEY,
      recipient_id TEXT NOT NULL REFERENCES client_identities(recipient_id),
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      revoked_at_ms INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS client_sessions_recipient_active
      ON client_sessions (recipient_id, revoked_at_ms, expires_at_ms, created_at_ms);
    CREATE TABLE IF NOT EXISTS client_grant_intents (
      intent_id TEXT PRIMARY KEY,
      recipient_id TEXT NOT NULL REFERENCES client_identities(recipient_id),
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
      decision TEXT CHECK (decision IS NULL OR decision IN ('accept', 'reject', 'ban')),
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      completed_at_ms INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS client_grant_intents_recipient
      ON client_grant_intents (recipient_id, status, expires_at_ms);
    CREATE TABLE IF NOT EXISTS client_store_metadata (
      metadata_key TEXT PRIMARY KEY,
      metadata_value TEXT NOT NULL
    ) STRICT;
  `);
  ensureIdentityCipherColumns(database);
  try {
    verifyIdentityKey(database, identityKey);
  } catch (error) {
    database.close();
    throw error;
  }
  protectDatabaseFiles(resolved);

  const selectIdentity = database.prepare(`
    SELECT recipient_id, subject_ciphertext, subject_nonce, subject_tag
    FROM client_identities
    WHERE provider = ? AND subject_hash = ?
  `);
  const insertIdentity = database.prepare(`
    INSERT INTO client_identities (
      provider, subject_hash, subject_ciphertext, subject_nonce, subject_tag, recipient_id, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const updateIdentityCipher = database.prepare(`
    UPDATE client_identities
    SET subject_ciphertext = ?, subject_nonce = ?, subject_tag = ?
    WHERE provider = ? AND subject_hash = ? AND recipient_id = ?
  `);
  const selectRecipient = database.prepare(`
    SELECT recipient_id FROM client_identities WHERE recipient_id = ?
  `);
  const selectProviderSubject = database.prepare(`
    SELECT recipient_id, subject_ciphertext, subject_nonce, subject_tag
    FROM client_identities
    WHERE recipient_id = ? AND provider = ?
  `);
  const insertSession = database.prepare(`
    INSERT INTO client_sessions (token_hash, recipient_id, created_at_ms, expires_at_ms, revoked_at_ms)
    VALUES (?, ?, ?, ?, NULL)
  `);
  const selectActiveSessions = database.prepare(`
    SELECT token_hash
    FROM client_sessions
    WHERE recipient_id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?
    ORDER BY created_at_ms ASC, rowid ASC
  `);
  const revokeSessionHash = database.prepare(`
    UPDATE client_sessions SET revoked_at_ms = ? WHERE token_hash = ? AND revoked_at_ms IS NULL
  `);
  const selectSession = database.prepare(`
    SELECT recipient_id, expires_at_ms, revoked_at_ms
    FROM client_sessions
    WHERE token_hash = ?
  `);
  const revokeSessionByHash = database.prepare(`
    UPDATE client_sessions
    SET revoked_at_ms = ?
    WHERE token_hash = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?
  `);
  const deleteInactiveSessions = database.prepare(`
    DELETE FROM client_sessions
    WHERE revoked_at_ms IS NOT NULL OR expires_at_ms <= ?
  `);
  const insertGrantIntent = database.prepare(`
    INSERT INTO client_grant_intents (
      intent_id, recipient_id, status, decision, created_at_ms, expires_at_ms, completed_at_ms
    ) VALUES (?, ?, 'pending', NULL, ?, ?, NULL)
  `);
  const selectGrantIntent = database.prepare(`
    SELECT intent_id, status, decision, expires_at_ms, completed_at_ms
    FROM client_grant_intents
    WHERE intent_id = ? AND recipient_id = ?
  `);
  const completeGrantIntentRow = database.prepare(`
    UPDATE client_grant_intents
    SET status = 'completed', decision = ?, completed_at_ms = ?
    WHERE intent_id = ? AND recipient_id = ? AND status = 'pending'
  `);
  const deleteExpiredPendingGrantIntents = database.prepare(`
    DELETE FROM client_grant_intents
    WHERE status = 'pending' AND expires_at_ms <= ?
  `);
  const deleteOldCompletedGrantIntents = database.prepare(`
    DELETE FROM client_grant_intents
    WHERE status = 'completed' AND completed_at_ms IS NOT NULL AND completed_at_ms <= ?
  `);
  const countPendingGrantIntents = database.prepare(`
    SELECT COUNT(*) AS count
    FROM client_grant_intents
    WHERE recipient_id = ? AND status = 'pending' AND expires_at_ms > ?
  `);
  const countRetainedGrantIntents = database.prepare(`
    SELECT COUNT(*) AS count
    FROM client_grant_intents
    WHERE recipient_id = ?
  `);
  const deleteGrantIntentsByRecipient = database.prepare(`
    DELETE FROM client_grant_intents WHERE recipient_id = ?
  `);
  const deleteSessionsByRecipient = database.prepare(`
    DELETE FROM client_sessions WHERE recipient_id = ?
  `);
  const deleteIdentityByRecipient = database.prepare(`
    DELETE FROM client_identities WHERE recipient_id = ?
  `);
  let closed = false;

  function resolveOrCreateRecipient(identity) {
    ensureOpen();
    const provider = requiredText(identity && identity.provider, 'identity.provider');
    const subject = requiredText(identity && identity.subject, 'identity.subject');
    const subjectHash = hashText(`${provider}\0${subject}`);
    const existing = selectIdentity.get(provider, subjectHash);
    if (existing) {
      if (!hasEncryptedSubject(existing)) {
        const encrypted = encryptIdentitySubject({
          identityKey,
          provider,
          randomBytes,
          recipientId: existing.recipient_id,
          subject,
        });
        updateIdentityCipher.run(
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.tag,
          provider,
          subjectHash,
          existing.recipient_id,
        );
      } else if (decryptIdentitySubject({ identityKey, provider, recipientId: existing.recipient_id, row: existing }) !== subject) {
        throw new Error('stored client identity does not match the supplied subject');
      }
      return { recipientId: existing.recipient_id, created: false };
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const recipientId = `rec_${opaqueValue(randomBytes, 16)}`;
      const encrypted = encryptIdentitySubject({
        identityKey,
        provider,
        randomBytes,
        recipientId,
        subject,
      });
      try {
        insertIdentity.run(
          provider,
          subjectHash,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.tag,
          recipientId,
          currentTimeMs(now),
        );
        return { recipientId, created: true };
      } catch (error) {
        if (!String(error && error.message).includes('UNIQUE constraint failed: client_identities.recipient_id')) {
          throw error;
        }
      }
    }
    throw new Error('unable to allocate a unique recipient identifier');
  }

  function resolveProviderSubject({ recipientId, provider } = {}) {
    ensureOpen();
    const resolvedRecipientId = requiredText(recipientId, 'recipientId');
    const resolvedProvider = requiredText(provider, 'provider');
    const row = selectProviderSubject.get(resolvedRecipientId, resolvedProvider);
    if (!row) return null;
    if (!hasEncryptedSubject(row)) throw new Error('stored client identity is not encrypted');
    return decryptIdentitySubject({
      identityKey,
      provider: resolvedProvider,
      recipientId: resolvedRecipientId,
      row,
    });
  }

  function createSession({ recipientId } = {}) {
    ensureOpen();
    const resolvedRecipientId = requiredText(recipientId, 'recipientId');
    if (!selectRecipient.get(resolvedRecipientId)) throw publicStoreError('recipient not found', 404, 'RECIPIENT_NOT_FOUND');
    const createdAtMs = currentTimeMs(now);
    const expiresAtMs = safeTimestampAdd(createdAtMs, resolvedSessionTtlMs, 'session expiry');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const token = opaqueValue(randomBytes, 32);
      try {
        database.exec('BEGIN IMMEDIATE');
        deleteInactiveSessions.run(createdAtMs);
        const activeSessions = selectActiveSessions.all(resolvedRecipientId, createdAtMs);
        const overflow = Math.max(0, activeSessions.length - resolvedMaxSessions + 1);
        for (const session of activeSessions.slice(0, overflow)) {
          revokeSessionHash.run(createdAtMs, session.token_hash);
        }
        insertSession.run(hashText(token), resolvedRecipientId, createdAtMs, expiresAtMs);
        deleteInactiveSessions.run(createdAtMs);
        database.exec('COMMIT');
        return {
          token,
          expiresAt: new Date(expiresAtMs).toISOString(),
        };
      } catch (error) {
        try {
          database.exec('ROLLBACK');
        } catch {
          // Preserve the insert error.
        }
        if (!String(error && error.message).includes('UNIQUE constraint failed: client_sessions.token_hash')) {
          throw error;
        }
      }
    }
    throw new Error('unable to allocate a unique session token');
  }

  function authenticateSession(token) {
    ensureOpen();
    const tokenHash = sessionTokenHash(token);
    if (!tokenHash) return null;
    const row = selectSession.get(tokenHash);
    if (!row || row.revoked_at_ms !== null || row.expires_at_ms <= currentTimeMs(now)) return null;
    return {
      recipientId: row.recipient_id,
      expiresAt: new Date(row.expires_at_ms).toISOString(),
    };
  }

  function revokeSession(token) {
    ensureOpen();
    const tokenHash = sessionTokenHash(token);
    if (!tokenHash) return false;
    const timestamp = currentTimeMs(now);
    return revokeSessionByHash.run(timestamp, tokenHash, timestamp).changes === 1;
  }

  async function createGrantIntent({ recipientId, ttlMs } = {}) {
    ensureOpen();
    const resolvedRecipientId = requiredText(recipientId, 'recipientId');
    if (!selectRecipient.get(resolvedRecipientId)) throw publicStoreError('recipient not found', 404, 'RECIPIENT_NOT_FOUND');
    const resolvedTtlMs = positiveSafeInteger(ttlMs, 'ttlMs');
    const createdAtMs = currentTimeMs(now);
    const expiresAtMs = safeTimestampAdd(createdAtMs, resolvedTtlMs, 'grant intent expiry');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const intentId = `intent_${opaqueValue(randomBytes, 24)}`;
      try {
        database.exec('BEGIN IMMEDIATE');
        deleteExpiredPendingGrantIntents.run(createdAtMs);
        deleteOldCompletedGrantIntents.run(Math.max(0, createdAtMs - COMPLETED_GRANT_RETENTION_MS));
        const pendingCount = Number(countPendingGrantIntents.get(resolvedRecipientId, createdAtMs).count);
        if (pendingCount >= resolvedMaxPendingGrantIntents) {
          throw publicStoreError(
            'too many pending grant intents',
            429,
            'GRANT_INTENT_LIMIT_REACHED',
          );
        }
        const retainedCount = Number(countRetainedGrantIntents.get(resolvedRecipientId).count);
        if (retainedCount >= resolvedMaxRetainedGrantIntents) {
          throw publicStoreError(
            'too many recent grant intents',
            429,
            'GRANT_INTENT_RATE_LIMIT_REACHED',
          );
        }
        insertGrantIntent.run(intentId, resolvedRecipientId, createdAtMs, expiresAtMs);
        database.exec('COMMIT');
        return {
          intentId,
          expiresAt: new Date(expiresAtMs).toISOString(),
        };
      } catch (error) {
        try {
          database.exec('ROLLBACK');
        } catch {
          // Preserve the insert or capacity error.
        }
        if (!String(error && error.message).includes('UNIQUE constraint failed: client_grant_intents.intent_id')) {
          throw error;
        }
      }
    }
    throw new Error('unable to allocate a unique grant intent identifier');
  }

  async function getGrantIntent({ recipientId, intentId } = {}) {
    ensureOpen();
    const resolvedRecipientId = requiredText(recipientId, 'recipientId');
    const resolvedIntentId = requiredText(intentId, 'intentId');
    const row = selectGrantIntent.get(resolvedIntentId, resolvedRecipientId);
    if (!row) throw publicStoreError('grant intent not found', 404, 'GRANT_INTENT_NOT_FOUND');
    if (row.status === 'pending' && row.expires_at_ms <= currentTimeMs(now)) {
      throw publicStoreError('grant intent expired', 409, 'GRANT_INTENT_EXPIRED');
    }
    return grantIntentView(row);
  }

  async function completeGrantIntent({ recipientId, intentId, decision } = {}) {
    ensureOpen();
    const resolvedRecipientId = requiredText(recipientId, 'recipientId');
    const resolvedIntentId = requiredText(intentId, 'intentId');
    const resolvedDecision = grantDecision(decision);
    database.exec('BEGIN IMMEDIATE');
    try {
      const row = selectGrantIntent.get(resolvedIntentId, resolvedRecipientId);
      if (!row) throw publicStoreError('grant intent not found', 404, 'GRANT_INTENT_NOT_FOUND');
      if (row.status === 'completed') {
        if (row.decision !== resolvedDecision) {
          throw publicStoreError('grant intent already completed', 409, 'GRANT_INTENT_ALREADY_COMPLETED');
        }
        database.exec('COMMIT');
        return grantIntentView(row);
      }
      const completedAtMs = currentTimeMs(now);
      if (row.expires_at_ms <= completedAtMs) {
        throw publicStoreError('grant intent expired', 409, 'GRANT_INTENT_EXPIRED');
      }
      const update = completeGrantIntentRow.run(
        resolvedDecision,
        completedAtMs,
        resolvedIntentId,
        resolvedRecipientId,
      );
      const completed = selectGrantIntent.get(resolvedIntentId, resolvedRecipientId);
      if (update.changes !== 1 || !completed || completed.decision !== resolvedDecision) {
        throw publicStoreError('grant intent completion conflicted', 409, 'GRANT_INTENT_ALREADY_COMPLETED');
      }
      database.exec('COMMIT');
      return grantIntentView(completed);
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Preserve the completion error.
      }
      throw error;
    }
  }

  function deleteRecipientIdentity({ recipientId } = {}) {
    ensureOpen();
    const resolvedRecipientId = requiredText(recipientId, 'recipientId');
    if (!selectRecipient.get(resolvedRecipientId)) return false;
    database.exec('BEGIN IMMEDIATE');
    try {
      deleteGrantIntentsByRecipient.run(resolvedRecipientId);
      deleteSessionsByRecipient.run(resolvedRecipientId);
      const deleted = deleteIdentityByRecipient.run(resolvedRecipientId).changes === 1;
      database.exec('COMMIT');
      return deleted;
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Preserve the original deletion failure.
      }
      throw error;
    }
  }

  function verifyTemplateBinding(templateId) {
    ensureOpen();
    const resolvedTemplateId = requiredText(templateId, 'templateId');
    const metadataKey = 'wechat-template-binding-v1';
    const expected = hashText(`live-reminder-wechat-template-v1\0${resolvedTemplateId}`);
    const existing = database.prepare(`
      SELECT metadata_value FROM client_store_metadata WHERE metadata_key = ?
    `).get(metadataKey);
    if (!existing) {
      database.prepare(`
        INSERT INTO client_store_metadata (metadata_key, metadata_value) VALUES (?, ?)
      `).run(metadataKey, expected);
      return { templateId: resolvedTemplateId };
    }
    const actualBuffer = Buffer.from(String(existing.metadata_value), 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
      throw new Error('notification template does not match the existing client database');
    }
    return { templateId: resolvedTemplateId };
  }

  function close() {
    if (closed) return;
    closed = true;
    database.close();
  }

  function ensureOpen() {
    if (closed) throw new Error('SQLite client store is closed');
  }

  return Object.freeze({
    authenticateSession,
    close,
    completeGrantIntent,
    createGrantIntent,
    createSession,
    deleteRecipientIdentity,
    filename: resolved,
    getGrantIntent,
    resolveProviderSubject,
    resolveOrCreateRecipient,
    revokeSession,
    verifyTemplateBinding,
  });
}

function ensureIdentityCipherColumns(database) {
  const existing = new Set(database.prepare('PRAGMA table_info(client_identities)').all().map(row => row.name));
  for (const column of ['subject_ciphertext', 'subject_nonce', 'subject_tag']) {
    if (!existing.has(column)) database.exec(`ALTER TABLE client_identities ADD COLUMN ${column} TEXT`);
  }
}

function verifyIdentityKey(database, identityKey) {
  const metadataKey = 'identity-key-check-v1';
  const expected = crypto.createHmac('sha256', identityKey)
    .update('live-reminder-client-store-key-check-v1')
    .digest('hex');
  const existing = database.prepare(`
    SELECT metadata_value FROM client_store_metadata WHERE metadata_key = ?
  `).get(metadataKey);
  if (existing) {
    const actualBuffer = Buffer.from(String(existing.metadata_value), 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
      throw new Error('CLIENT_IDENTITY_SECRET does not match the existing client database');
    }
    return;
  }

  const encryptedIdentity = database.prepare(`
    SELECT provider, recipient_id, subject_ciphertext, subject_nonce, subject_tag
    FROM client_identities
    WHERE subject_ciphertext IS NOT NULL AND subject_nonce IS NOT NULL AND subject_tag IS NOT NULL
    LIMIT 1
  `).get();
  if (encryptedIdentity) {
    try {
      decryptIdentitySubject({
        identityKey,
        provider: encryptedIdentity.provider,
        recipientId: encryptedIdentity.recipient_id,
        row: encryptedIdentity,
      });
    } catch {
      throw new Error('CLIENT_IDENTITY_SECRET does not match the existing client database');
    }
  }
  database.prepare(`
    INSERT INTO client_store_metadata (metadata_key, metadata_value) VALUES (?, ?)
  `).run(metadataKey, expected);
}

function hasEncryptedSubject(row) {
  return typeof row.subject_ciphertext === 'string' && row.subject_ciphertext !== ''
    && typeof row.subject_nonce === 'string' && row.subject_nonce !== ''
    && typeof row.subject_tag === 'string' && row.subject_tag !== '';
}

function encryptIdentitySubject({ identityKey, provider, randomBytes, recipientId, subject }) {
  const nonce = randomBytes(12);
  if (!Buffer.isBuffer(nonce) || nonce.length !== 12) {
    throw new TypeError('randomBytes must return exactly 12 bytes');
  }
  const cipher = crypto.createCipheriv('aes-256-gcm', identityKey, nonce);
  cipher.setAAD(Buffer.from(`${provider}\0${recipientId}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(subject, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64url'),
    nonce: nonce.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  };
}

function decryptIdentitySubject({ identityKey, provider, recipientId, row }) {
  try {
    const nonce = Buffer.from(row.subject_nonce, 'base64url');
    const tag = Buffer.from(row.subject_tag, 'base64url');
    const ciphertext = Buffer.from(row.subject_ciphertext, 'base64url');
    if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error('invalid encrypted identity');
    const decipher = crypto.createDecipheriv('aes-256-gcm', identityKey, nonce);
    decipher.setAAD(Buffer.from(`${provider}\0${recipientId}`, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('stored client identity could not be decrypted');
  }
}

function requiredText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > 500) throw new RangeError(`${name} must be at most 500 characters`);
  return normalized;
}

function currentTimeMs(now) {
  const value = Number(now());
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('now must return a non-negative millisecond timestamp');
  return value;
}

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function boundedSafeInteger(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function safeTimestampAdd(timestamp, duration, name) {
  const result = timestamp + duration;
  if (!Number.isSafeInteger(result)) throw new RangeError(`${name} exceeds the safe integer range`);
  return result;
}

function sessionTokenHash(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  let decoded;
  try {
    decoded = Buffer.from(token, 'base64url');
  } catch {
    return null;
  }
  return decoded.length === 32 ? hashText(token) : null;
}

function grantDecision(value) {
  if (!['accept', 'reject', 'ban'].includes(value)) {
    throw new TypeError('decision must be accept, reject, or ban');
  }
  return value;
}

function grantIntentView(row) {
  return {
    intentId: row.intent_id,
    status: row.status,
    decision: row.decision,
    expiresAt: new Date(row.expires_at_ms).toISOString(),
    completedAt: row.completed_at_ms === null ? null : new Date(row.completed_at_ms).toISOString(),
  };
}

function opaqueValue(randomBytes, byteLength) {
  const value = randomBytes(byteLength);
  if (!Buffer.isBuffer(value) || value.length !== byteLength) {
    throw new TypeError(`randomBytes must return exactly ${byteLength} bytes`);
  }
  return value.toString('base64url');
}

function hashText(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function publicStoreError(message, publicStatus, publicCode) {
  const error = new Error(message);
  error.publicStatus = publicStatus;
  error.publicCode = publicCode;
  return error;
}

function protectDatabaseFiles(filename) {
  if (filename === ':memory:' || process.platform === 'win32') return;
  for (const candidate of [filename, `${filename}-wal`, `${filename}-shm`]) {
    if (fs.existsSync(candidate)) fs.chmodSync(candidate, 0o600);
  }
}

module.exports = {
  createSqliteClientStore,
};
