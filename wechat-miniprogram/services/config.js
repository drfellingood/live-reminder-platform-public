let localConfig = null;

try {
  localConfig = require('../config.local.js');
} catch (error) {
  localConfig = null;
}

function configurationError(message) {
  const error = new Error(message);
  error.code = 'CONFIG_REQUIRED';
  return error;
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function getConfig() {
  const apiBaseUrl = normalizeBaseUrl(localConfig && localConfig.apiBaseUrl);
  const isHttps = /^https:\/\//i.test(apiBaseUrl);
  const isLoopback = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(apiBaseUrl);

  if (!apiBaseUrl || (!isHttps && !isLoopback) || /\.invalid$/i.test(apiBaseUrl)) {
    throw configurationError('A private HTTPS API address is required in config.local.js');
  }

  return {
    apiBaseUrl,
    requestTimeoutMs: Number(localConfig.requestTimeoutMs) > 0
      ? Number(localConfig.requestTimeoutMs)
      : 10000,
    staleAfterMs: Number(localConfig.staleAfterMs) > 0
      ? Number(localConfig.staleAfterMs)
      : 300000,
  };
}

function isConfigured() {
  try {
    getConfig();
    return true;
  } catch (error) {
    return false;
  }
}

module.exports = {
  getConfig,
  isConfigured,
};
