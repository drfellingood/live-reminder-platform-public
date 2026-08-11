const api = require('../../services/api');
const { fetchClientData } = require('../../services/client-data');
const { isConfigured } = require('../../services/config');
const { messageKeyForError } = require('../../services/errors');
const session = require('../../services/session');
const { clearPendingGrant } = require('../../services/grant-recovery');
const { applyPageLocale } = require('../../utils/i18n');
const { formatTimestamp } = require('../../utils/view-model');

function confirmModal(title, content, confirmText, cancelText) {
  return new Promise((resolve) => {
    wx.showModal({
      title,
      content,
      confirmText,
      cancelText,
      success(result) {
        resolve(Boolean(result.confirm));
      },
      fail() {
        resolve(false);
      },
    });
  });
}

Page({
  data: {
    locale: 'en',
    t: {},
    viewState: 'loading',
    errorTitle: '',
    errorMessage: '',
    remindersEnabled: false,
    savingReminders: false,
    deletingAccount: false,
    apiConfigured: false,
    refreshedAt: '',
  },

  onShow() {
    applyPageLocale(this, 'settingsTab');
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh(options) {
    const { t } = applyPageLocale(this, 'settingsTab');
    const apiConfigured = isConfigured();
    const refreshId = (this.refreshId || 0) + 1;
    this.refreshId = refreshId;
    this.setData({
      viewState: 'loading',
      apiConfigured,
      errorTitle: '',
      errorMessage: '',
    });

    try {
      const { me } = await fetchClientData(t, options);
      if (refreshId !== this.refreshId) return;
      this.setData({
        viewState: 'ready',
        remindersEnabled: me.remindersEnabled,
        refreshedAt: formatTimestamp(Date.now()),
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

  onSelectLanguage(event) {
    const locale = event.currentTarget.dataset.locale;
    if (!locale || locale === this.data.locale) return;
    getApp().setLocale(locale);
    applyPageLocale(this, 'settingsTab');
    this.refresh();
  },

  async onReminderToggle(event) {
    if (this.data.savingReminders || this.data.deletingAccount || this.data.viewState !== 'ready') return;
    const enabled = Boolean(event.detail.value);
    const previous = this.data.remindersEnabled;
    this.setData({ remindersEnabled: enabled, savingReminders: true });
    try {
      await api.setReminders(enabled);
      wx.showToast({ title: this.data.t.saveSuccess, icon: 'success' });
    } catch (error) {
      this.setData({ remindersEnabled: previous });
      await this.refresh({ forceAuth: error && error.code === 'UNAUTHORIZED' });
      wx.showToast({
        title: this.data.t[messageKeyForError(error)] || this.data.t.generalError,
        icon: 'none',
      });
    } finally {
      this.setData({ savingReminders: false });
    }
  },

  async onSignOut() {
    if (this.data.deletingAccount) return;
    const confirmed = await confirmModal(
      this.data.t.signOutConfirmTitle,
      this.data.t.signOutConfirmBody,
      this.data.t.confirm,
      this.data.t.cancel
    );
    if (!confirmed) return;

    try {
      if (session.getSessionToken()) await api.deleteSession();
    } catch (error) {
      // Local sign-out still removes the device credential when the server is unavailable.
    } finally {
      session.markSignedOut();
    }
    wx.showToast({ title: this.data.t.signOutSuccess, icon: 'success' });
    this.setData({ viewState: 'unauthorized' });
  },

  async onDeleteAccount() {
    if (this.data.deletingAccount) return;
    const confirmed = await confirmModal(
      this.data.t.deleteAccountConfirmTitle,
      this.data.t.deleteAccountConfirmBody,
      this.data.t.confirm,
      this.data.t.cancel
    );
    if (!confirmed) return;

    this.setData({ deletingAccount: true });
    try {
      await api.deleteAccount();
      clearPendingGrant();
      session.markSignedOut();
      wx.showToast({ title: this.data.t.deleteAccountSuccess, icon: 'success' });
      this.setData({ viewState: 'unauthorized' });
    } catch (error) {
      wx.showToast({ title: this.data.t.deleteAccountFailed, icon: 'none' });
    } finally {
      this.setData({ deletingAccount: false });
    }
  },
});
