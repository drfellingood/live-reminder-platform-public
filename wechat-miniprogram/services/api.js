const { getConfig } = require('./config');
const { ClientError, normalizeRequestError } = require('./errors');
const { clearSessionToken, getSessionToken } = require('./session');

function request({ path, method, data }) {
  const config = getConfig();
  const token = getSessionToken();
  if (!token) return Promise.reject(new ClientError('UNAUTHORIZED', 'A session is required', 401));

  return new Promise((resolve, reject) => {
    wx.request({
      url: `${config.apiBaseUrl}${path}`,
      method: method || 'GET',
      timeout: config.requestTimeoutMs,
      header: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      data,
      success(response) {
        if (response.statusCode === 401) {
          clearSessionToken();
          reject(new ClientError('UNAUTHORIZED', 'Session expired', 401));
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const body = response.data || {};
          reject(new ClientError(
            body.code || body.error || 'REQUEST_FAILED',
            body.message || 'Request failed',
            response.statusCode
          ));
          return;
        }
        const body = response.data;
        if (!body || typeof body !== 'object' || Array.isArray(body) || body.ok !== true ||
          !Object.prototype.hasOwnProperty.call(body, 'data')) {
          reject(new ClientError('INVALID_RESPONSE', 'The server response envelope is invalid', response.statusCode));
          return;
        }
        resolve(body);
      },
      fail(error) {
        reject(normalizeRequestError(error));
      },
    });
  });
}

function deleteSession() {
  return expectObjectData(request({ path: '/api/v1/client/session', method: 'DELETE' }));
}

function getChannels() {
  return request({ path: '/api/v1/client/channels' }).then((body) => {
    if (!Array.isArray(body.data) || body.data.some((channel) => !isChannelData(channel))) {
      throw new ClientError('INVALID_RESPONSE', 'Channel response data is invalid');
    }
    return body;
  });
}

function getMe() {
  return expectMeData(request({ path: '/api/v1/client/me' }));
}

function deleteAccount() {
  return expectObjectData(request({ path: '/api/v1/client/me', method: 'DELETE' }));
}

function setReminders(enabled) {
  return expectMeData(request({
    path: '/api/v1/client/me/reminders',
    method: 'PUT',
    data: { enabled: Boolean(enabled) },
  }));
}

function setSubscription(channelId, active) {
  return expectMeData(request({
    path: `/api/v1/client/me/subscriptions/${encodeURIComponent(channelId)}`,
    method: 'PUT',
    data: { active: Boolean(active) },
  }));
}

function createReminderGrant() {
  return request({
    path: '/api/v1/client/me/reminder-grants',
    method: 'POST',
    data: {},
  }).then((body) => {
    const data = body.data;
    if (!isObject(data) || !nonEmptyText(data.intentId) || !nonEmptyText(data.templateId) ||
      !nonEmptyText(data.expiresAt)) {
      throw new ClientError('INVALID_RESPONSE', 'Reminder grant response data is invalid');
    }
    return body;
  });
}

function completeReminderGrant(intentId, completion) {
  return expectObjectData(request({
    path: `/api/v1/client/me/reminder-grants/${encodeURIComponent(intentId)}/complete`,
    method: 'POST',
    data: completion,
  }));
}

function expectObjectData(promise) {
  return promise.then((body) => {
    if (!isObject(body.data)) throw new ClientError('INVALID_RESPONSE', 'Response data is invalid');
    return body;
  });
}

function expectMeData(promise) {
  return promise.then((body) => {
    const data = body.data;
    if (!isObject(data) || !isObject(data.reminders) || typeof data.reminders.enabled !== 'boolean' ||
      !Number.isFinite(Number(data.reminders.availableCredits)) || !Array.isArray(data.subscriptions) ||
      !Array.isArray(data.activity) || !nonEmptyText(data.templateId)) {
      throw new ClientError('INVALID_RESPONSE', 'Account response data is invalid');
    }
    return body;
  });
}

function isChannelData(value) {
  return isObject(value) && nonEmptyText(value.channelId) && nonEmptyText(value.name) &&
    ['live', 'offline', 'unknown'].includes(value.status) && typeof value.stale === 'boolean';
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

module.exports = {
  completeReminderGrant,
  createReminderGrant,
  deleteAccount,
  deleteSession,
  getChannels,
  getMe,
  request,
  setReminders,
  setSubscription,
};
