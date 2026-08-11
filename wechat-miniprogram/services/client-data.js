const api = require('./api');
const { getConfig } = require('./config');
const session = require('./session');
const { normalizeChannels, normalizeMe } = require('../utils/view-model');

async function fetchClientData(t, options) {
  await session.ensureSession({ force: Boolean(options && options.forceAuth) });
  const [channelsPayload, mePayload] = await Promise.all([
    api.getChannels(),
    api.getMe(),
  ]);
  const me = normalizeMe(mePayload);
  const channels = normalizeChannels(channelsPayload, me, getConfig().staleAfterMs, t);
  const namesById = new Map(channels.map((channel) => [channel.id, channel.displayName]));
  me.activity = me.activity.map((entry) => ({
    ...entry,
    channelDisplayName: entry.channelDisplayName || namesById.get(String(entry.channelId || '')),
  }));
  return { channels, me };
}

module.exports = {
  fetchClientData,
};
