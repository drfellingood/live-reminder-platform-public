const STORAGE_KEY = 'liveReminder.pendingGrantCompletion';
const DECISIONS = new Set(['accept', 'reject', 'ban']);
const DEFINITIVE_ERRORS = new Set([
  'GRANT_INTENT_EXPIRED',
  'GRANT_INTENT_NOT_FOUND',
]);

function normalizePendingGrant(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const intentId = String(value.intentId || '').trim();
  const decision = String(value.decision || '').trim();
  if (!intentId || !DECISIONS.has(decision)) return null;
  return { intentId, decision };
}

function loadPendingGrant() {
  const pending = normalizePendingGrant(wx.getStorageSync(STORAGE_KEY));
  if (!pending) wx.removeStorageSync(STORAGE_KEY);
  return pending;
}

function savePendingGrant(value) {
  const pending = normalizePendingGrant(value);
  if (!pending) throw new TypeError('pending grant completion is invalid');
  wx.setStorageSync(STORAGE_KEY, pending);
  return pending;
}

function clearPendingGrant() {
  wx.removeStorageSync(STORAGE_KEY);
}

async function completePendingGrant(api) {
  if (!api || typeof api.completeReminderGrant !== 'function') {
    throw new TypeError('api.completeReminderGrant is required');
  }
  const pending = loadPendingGrant();
  if (!pending) return null;
  try {
    const result = await api.completeReminderGrant(pending.intentId, { decision: pending.decision });
    clearPendingGrant();
    return result;
  } catch (error) {
    if (DEFINITIVE_ERRORS.has(error && error.code)) clearPendingGrant();
    throw error;
  }
}

module.exports = {
  STORAGE_KEY,
  clearPendingGrant,
  completePendingGrant,
  loadPendingGrant,
  savePendingGrant,
};
