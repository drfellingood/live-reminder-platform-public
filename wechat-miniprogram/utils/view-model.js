const ALLOWED_STATES = ['live', 'offline', 'unknown'];
const ALLOWED_RESULTS = ['pending', 'in-flight', 'accepted', 'failed', 'ambiguous'];
const RESULT_TITLE_KEYS = Object.freeze({
  pending: 'deliveryPending',
  'in-flight': 'deliveryInFlight',
  accepted: 'deliveryAccepted',
  failed: 'deliveryFailed',
  ambiguous: 'deliveryAmbiguous',
});

function unwrap(payload, key) {
  if (!payload || typeof payload !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(payload, key)) return payload[key];
  if (payload.data && Object.prototype.hasOwnProperty.call(payload.data, key)) return payload.data[key];
  return null;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function unwrapData(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  return Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
}

function formatTimestamp(value) {
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normalizeSubscriptionIds(me) {
  const raw = toArray(me && (me.subscriptions || me.channelSubscriptions));
  return raw.reduce((set, item) => {
    if (typeof item === 'string') set.add(item);
    if (item && item.active !== false && (item.channelId || item.id)) set.add(String(item.channelId || item.id));
    return set;
  }, new Set());
}

function normalizeMe(payload) {
  const responseData = unwrapData(payload);
  const me = unwrap(responseData, 'me') || responseData || {};
  const reminders = me.reminders && typeof me.reminders === 'object' ? me.reminders : {};
  const credits = me.credits && typeof me.credits === 'object' ? me.credits : {};
  const activity = unwrap(responseData, 'activity') || me.activity || me.deliveries;
  return {
    remindersEnabled: Boolean(
      me.remindersEnabled !== undefined
        ? me.remindersEnabled
        : reminders.enabled !== undefined
          ? reminders.enabled
          : me.enabled !== undefined
            ? me.enabled
            : me.pushEnabled
    ),
    availableCredits: Math.max(0, Number(
      me.availableReminderCredits !== undefined
        ? me.availableReminderCredits
        : reminders.availableCredits !== undefined
          ? reminders.availableCredits
          : credits.available !== undefined
            ? credits.available
            : me.credits
    ) || 0),
    templateId: String(me.templateId || reminders.templateId || '').trim(),
    subscriptionIds: normalizeSubscriptionIds(me),
    activity: toArray(activity),
  };
}

function normalizeChannel(channel, subscriptionIds, staleAfterMs, now, t) {
  const id = String(channel && (channel.id || channel.channelId) || '').trim();
  const rawState = String(channel && (channel.status || channel.state) || '').toLowerCase();
  const stableState = ALLOWED_STATES.includes(rawState) ? rawState : 'unknown';
  const updatedAt = channel && (channel.observedAt || channel.updatedAt || channel.lastObservedAt);
  const updatedAtMs = typeof updatedAt === 'number' ? updatedAt : Date.parse(updatedAt);
  const hasServerFreshness = Boolean(channel) && typeof channel.stale === 'boolean';
  const stale = hasServerFreshness
    ? channel.stale
    : Number.isFinite(updatedAtMs) && Number.isFinite(staleAfterMs) && now - updatedAtMs > staleAfterMs;
  const displayState = stale ? 'stale' : stableState;

  return {
    id,
    displayName: String(channel && (channel.displayName || channel.name) || t.unnamedTarget),
    sourceLabel: String(channel && (channel.sourceLabel || channel.source || channel.platform) || t.unknownSource),
    stableState,
    displayState,
    statusText: t[`status${displayState[0].toUpperCase()}${displayState.slice(1)}`],
    statusHint: t[`${displayState}Hint`] || t.unknownHint,
    updatedAtLabel: formatTimestamp(updatedAt) || t.neverUpdated,
    subscribed: subscriptionIds.has(id),
    saving: false,
  };
}

function normalizeChannels(payload, me, staleAfterMs, t) {
  const responseData = unwrapData(payload);
  const raw = unwrap(responseData, 'channels');
  const subscriptionIds = me.subscriptionIds || new Set();
  return toArray(raw || responseData).map((channel) => normalizeChannel(
    channel,
    subscriptionIds,
    staleAfterMs,
    Date.now(),
    t
  )).filter((channel) => channel.id);
}

function normalizeActivity(entries, t) {
  return toArray(entries).map((entry, index) => {
    const declaredKind = entry && (entry.kind || entry.type);
    const kind = declaredKind === 'reminder' || (entry && entry.deliveryStatus) ? 'reminder' : 'status';
    const rawValue = String(entry && (entry.result || entry.deliveryStatus || entry.status || entry.state) || 'unknown').toLowerCase();
    const value = kind === 'reminder'
      ? (ALLOWED_RESULTS.includes(rawValue) ? rawValue : 'ambiguous')
      : (ALLOWED_STATES.includes(rawValue) ? rawValue : 'unknown');
    const titleKey = kind === 'reminder'
      ? RESULT_TITLE_KEYS[value]
      : `event${value[0].toUpperCase()}${value.slice(1)}`;
    return {
      id: String(entry && (entry.id || entry.eventId || entry.receiptId) || `activity-${index}`),
      kind,
      kindText: kind === 'reminder' ? t.reminderResult : t.statusEvent,
      value,
      title: t[titleKey] || t.eventUnknown,
      channelName: String(entry && (entry.channelDisplayName || entry.channelName || entry.channelId) || t.unnamedTarget),
      timestampLabel: formatTimestamp(entry && (entry.occurredAt || entry.createdAt || entry.updatedAt)) || t.neverUpdated,
      handsetText: kind === 'reminder'
        ? (value === 'pending' || value === 'in-flight' ? t.handsetNotSent : t.handsetUnknown)
        : '',
    };
  });
}

module.exports = {
  formatTimestamp,
  normalizeActivity,
  normalizeChannels,
  normalizeMe,
};
