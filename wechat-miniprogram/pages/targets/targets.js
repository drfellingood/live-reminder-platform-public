const api = require('../../services/api');
const { fetchClientData } = require('../../services/client-data');
const { messageKeyForError } = require('../../services/errors');
const { applyPageLocale } = require('../../utils/i18n');

Page({
  data: {
    locale: 'en',
    t: {},
    viewState: 'loading',
    errorTitle: '',
    errorMessage: '',
    channels: [],
  },

  onShow() {
    applyPageLocale(this, 'targetsTab');
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh(options) {
    const { t } = applyPageLocale(this, 'targetsTab');
    const refreshId = (this.refreshId || 0) + 1;
    this.refreshId = refreshId;
    this.setData({ viewState: 'loading', errorTitle: '', errorMessage: '' });
    try {
      const { channels } = await fetchClientData(t, options);
      if (refreshId !== this.refreshId) return;
      this.setData({
        channels,
        viewState: channels.length ? 'ready' : 'empty',
      });
    } catch (error) {
      if (refreshId !== this.refreshId) return;
      const unauthorized = error && error.code === 'UNAUTHORIZED';
      const configuration = error && error.code === 'CONFIG_REQUIRED';
      this.setData({
        viewState: unauthorized ? 'unauthorized' : 'error',
        errorTitle: configuration ? t.configurationNeeded : unauthorized ? t.unauthorizedTitle : t.serverError,
        errorMessage: t[messageKeyForError(error)] || t.generalError,
      });
    }
  },

  onRetry() {
    this.refresh({ forceAuth: this.data.viewState === 'unauthorized' });
  },

  async onSubscriptionToggle(event) {
    const channelId = String(event.currentTarget.dataset.channelId || '');
    const index = this.data.channels.findIndex((channel) => channel.id === channelId);
    if (index < 0 || this.data.channels[index].saving) return;

    const previous = this.data.channels[index].subscribed;
    const active = Boolean(event.detail.value);
    this.setData({
      [`channels[${index}].subscribed`]: active,
      [`channels[${index}].saving`]: true,
    });

    try {
      await api.setSubscription(channelId, active);
      wx.showToast({ title: this.data.t.saveSuccess, icon: 'success' });
    } catch (error) {
      this.setData({ [`channels[${index}].subscribed`]: previous });
      await this.refresh({ forceAuth: error && error.code === 'UNAUTHORIZED' });
      wx.showToast({
        title: this.data.t[messageKeyForError(error)] || this.data.t.subscriptionFailed,
        icon: 'none',
      });
    } finally {
      this.setData({ [`channels[${index}].saving`]: false });
    }
  },
});
