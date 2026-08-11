const messages = require('./messages');

const STORAGE_KEY = 'liveReminder.locale';
const DEFAULT_LOCALE = 'en';
const SUPPORTED_LOCALES = ['en', 'zhCN'];

function normalizeLocale(locale) {
  return SUPPORTED_LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
}

function getLocale() {
  return normalizeLocale(wx.getStorageSync(STORAGE_KEY));
}

function text(locale) {
  return messages[normalizeLocale(locale)];
}

function applyTabBarLocale(locale) {
  const t = text(locale);
  [t.monitorTab, t.targetsTab, t.activityTab, t.settingsTab].forEach((label, index) => {
    wx.setTabBarItem({ index, text: label });
  });
}

function applyPageLocale(page, titleKey) {
  const app = getApp();
  const locale = normalizeLocale(app.globalData.locale || getLocale());
  const t = text(locale);
  page.setData({ locale, t });
  wx.setNavigationBarTitle({ title: t[titleKey] || t.appName });
  applyTabBarLocale(locale);
  return { locale, t };
}

module.exports = {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  applyPageLocale,
  applyTabBarLocale,
  getLocale,
  normalizeLocale,
  text,
};
