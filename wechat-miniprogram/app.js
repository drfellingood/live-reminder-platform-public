const { getLocale, applyTabBarLocale } = require('./utils/i18n');

App({
  globalData: {
    locale: getLocale(),
  },

  onLaunch() {
    applyTabBarLocale(this.globalData.locale);
  },

  setLocale(locale) {
    this.globalData.locale = locale;
    wx.setStorageSync('liveReminder.locale', locale);
    applyTabBarLocale(locale);
  },
});
