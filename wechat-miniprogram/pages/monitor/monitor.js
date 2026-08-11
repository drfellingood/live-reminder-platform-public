const api = require('../../services/api');
const { fetchClientData } = require('../../services/client-data');
const { messageKeyForError, ClientError } = require('../../services/errors');
const {
  completePendingGrant,
  loadPendingGrant,
  savePendingGrant,
} = require('../../services/grant-recovery');
const { applyPageLocale } = require('../../utils/i18n');

function requestNotificationPermission(templateId) {
  return new Promise((resolve, reject) => {
    wx.requestSubscribeMessage({
      tmplIds: [templateId],
      success: resolve,
      fail: reject,
    });
  });
}

function readIntentId(payload) {
  const body = payload && payload.data ? payload.data : payload;
  return String(body && body.intentId || '').trim();
}

Page({
  data: {
    locale: 'en',
    t: {},
    viewState: 'loading',
    errorTitle: '',
    errorMessage: '',
    channels: [],
    remindersEnabled: false,
    availableCredits: 0,
    templateId: '',
    savingReminders: false,
    grantState: 'idle',
  },

  onShow() {
    applyPageLocale(this, 'monitorTab');
    this.refresh().then(() => this.reconcilePendingGrant({ silent: true }));
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh(options) {
    const { t } = applyPageLocale(this, 'monitorTab');
    const refreshId = (this.refreshId || 0) + 1;
    this.refreshId = refreshId;
    this.setData({ viewState: 'loading', errorMessage: '', errorTitle: '' });
    try {
      const { channels, me } = await fetchClientData(t, options);
      if (refreshId !== this.refreshId) return;
      const monitored = channels.filter((channel) => channel.subscribed);
      this.setData({
        viewState: monitored.length ? 'ready' : 'empty',
        channels: monitored,
        remindersEnabled: me.remindersEnabled,
        availableCredits: me.availableCredits,
        templateId: me.templateId,
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

  async onReminderToggle(event) {
    if (this.data.savingReminders) return;
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

  async onAddReminder() {
    if (this.data.grantState === 'saving') return;
    if (loadPendingGrant()) {
      await this.reconcilePendingGrant({ silent: false });
      return;
    }
    this.setData({ grantState: 'saving' });
    let intentId = '';
    try {
      const intent = await api.createReminderGrant();
      intentId = readIntentId(intent);
      if (!intentId) throw new ClientError('INVALID_RESPONSE', 'Reminder intent id is missing');
      const intentBody = intent && intent.data ? intent.data : intent;
      const intentTemplateId = String(intentBody && intentBody.templateId || '').trim();
      if (!intentTemplateId) throw new ClientError('INVALID_RESPONSE', 'Reminder template id is missing');

      let permission;
      try {
        permission = await requestNotificationPermission(intentTemplateId);
      } catch (promptError) {
        await api.completeReminderGrant(intentId, { decision: 'reject' });
        throw promptError;
      }

      const platformDecision = permission && permission[intentTemplateId];
      const completion = platformDecision === 'accept'
        ? { decision: 'accept' }
        : platformDecision === 'ban'
          ? { decision: 'ban' }
          : { decision: 'reject' };

      savePendingGrant({ intentId, decision: completion.decision });
      await completePendingGrant(api);
      const message = completion.decision === 'accept'
        ? this.data.t.grantAccepted
        : completion.decision === 'ban'
          ? this.data.t.grantBanned
          : this.data.t.grantRejected;
      wx.showToast({ title: message, icon: completion.decision === 'accept' ? 'success' : 'none' });
      await this.refresh();
    } catch (error) {
      if (error && error.code === 'UNAUTHORIZED') {
        await this.refresh({ forceAuth: true });
      }
      wx.showToast({
        title: this.data.t[messageKeyForError(error)] || this.data.t.grantFailed,
        icon: 'none',
      });
    } finally {
      this.setData({ grantState: loadPendingGrant() ? 'pending-sync' : 'idle' });
    }
  },

  async reconcilePendingGrant({ silent } = {}) {
    if (!loadPendingGrant() || this.data.grantState === 'saving') return false;
    this.setData({ grantState: 'saving' });
    try {
      await completePendingGrant(api);
      if (!silent) wx.showToast({ title: this.data.t.grantSynced, icon: 'success' });
      await this.refresh();
      return true;
    } catch (error) {
      if (error && error.code === 'UNAUTHORIZED') {
        await this.refresh({ forceAuth: true });
        try {
          await completePendingGrant(api);
          if (!silent) wx.showToast({ title: this.data.t.grantSynced, icon: 'success' });
          await this.refresh();
          return true;
        } catch {
          // Keep the saved completion for an explicit later retry.
        }
      }
      if (!silent) {
        wx.showToast({
          title: loadPendingGrant()
            ? this.data.t.grantSyncPending
            : (this.data.t[messageKeyForError(error)] || this.data.t.grantFailed),
          icon: 'none',
        });
      }
      return false;
    } finally {
      this.setData({ grantState: loadPendingGrant() ? 'pending-sync' : 'idle' });
    }
  },
});
