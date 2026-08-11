const { fetchClientData } = require('../../services/client-data');
const { messageKeyForError } = require('../../services/errors');
const { applyPageLocale } = require('../../utils/i18n');
const { normalizeActivity } = require('../../utils/view-model');

Page({
  data: {
    locale: 'en',
    t: {},
    viewState: 'loading',
    errorTitle: '',
    errorMessage: '',
    entries: [],
  },

  onShow() {
    applyPageLocale(this, 'activityTab');
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh(options) {
    const { t } = applyPageLocale(this, 'activityTab');
    const refreshId = (this.refreshId || 0) + 1;
    this.refreshId = refreshId;
    this.setData({ viewState: 'loading', errorTitle: '', errorMessage: '' });
    try {
      const { me } = await fetchClientData(t, options);
      if (refreshId !== this.refreshId) return;
      const entries = normalizeActivity(me.activity, t);
      this.setData({
        entries,
        viewState: entries.length ? 'ready' : 'empty',
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
});
