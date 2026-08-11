const { getConfig } = require('./config');
const { ClientError, normalizeRequestError } = require('./errors');

const STORAGE_KEY = 'liveReminder.sessionToken';
const SIGNED_OUT_KEY = 'liveReminder.signedOut';

function getSessionToken() {
  return String(wx.getStorageSync(STORAGE_KEY) || '').trim();
}

function setSessionToken(token) {
  const normalized = String(token || '').trim();
  if (!normalized) throw new ClientError('INVALID_RESPONSE', 'Authentication response did not include a token');
  wx.setStorageSync(STORAGE_KEY, normalized);
  wx.removeStorageSync(SIGNED_OUT_KEY);
}

function clearSessionToken() {
  wx.removeStorageSync(STORAGE_KEY);
}

function markSignedOut() {
  clearSessionToken();
  wx.setStorageSync(SIGNED_OUT_KEY, true);
}

function isSignedOut() {
  return wx.getStorageSync(SIGNED_OUT_KEY) === true;
}

function getLoginCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      success(result) {
        const code = String(result.code || '').trim();
        if (!code) {
          reject(new ClientError('AUTH_FAILED', 'wx.login did not return a code'));
          return;
        }
        resolve(code);
      },
      fail(error) {
        reject(normalizeRequestError(error));
      },
    });
  });
}

function exchangeCode(code) {
  const config = getConfig();
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${config.apiBaseUrl}/api/v1/client/auth/wechat`,
      method: 'POST',
      timeout: config.requestTimeoutMs,
      header: { 'content-type': 'application/json' },
      data: { code },
      success(response) {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new ClientError(
            response.statusCode === 401 ? 'UNAUTHORIZED' : 'AUTH_FAILED',
            'Authentication was rejected',
            response.statusCode
          ));
          return;
        }
        const body = response.data;
        if (!body || typeof body !== 'object' || Array.isArray(body) || body.ok !== true ||
          !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
          reject(new ClientError('INVALID_RESPONSE', 'Authentication response envelope is invalid', response.statusCode));
          return;
        }
        const responseData = body.data;
        const token = responseData.accessToken || responseData.token || responseData.sessionToken;
        try {
          setSessionToken(token);
          resolve(responseData);
        } catch (error) {
          reject(error);
        }
      },
      fail(error) {
        reject(normalizeRequestError(error));
      },
    });
  });
}

async function authenticate() {
  clearSessionToken();
  const code = await getLoginCode();
  return exchangeCode(code);
}

async function ensureSession(options) {
  const force = Boolean(options && options.force);
  if (!force && getSessionToken()) return { reused: true };
  if (!force && isSignedOut()) {
    throw new ClientError('UNAUTHORIZED', 'Explicit sign-in is required', 401);
  }
  return authenticate();
}

module.exports = {
  STORAGE_KEY,
  authenticate,
  clearSessionToken,
  ensureSession,
  getSessionToken,
  isSignedOut,
  markSignedOut,
};
