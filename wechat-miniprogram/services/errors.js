class ClientError extends Error {
  constructor(code, message, statusCode) {
    super(message || code);
    this.name = 'ClientError';
    this.code = code;
    this.statusCode = statusCode || 0;
  }
}

function normalizeRequestError(error) {
  if (error && error.code) return error;
  return new ClientError('NETWORK_ERROR', error && error.errMsg ? error.errMsg : 'Network request failed');
}

function messageKeyForError(error) {
  if (!error) return 'generalError';
  if (error.code === 'CONFIG_REQUIRED') return 'configurationBody';
  if (error.code === 'UNAUTHORIZED') return 'sessionExpired';
  if (error.code === 'INVALID_RESPONSE') return 'invalidResponse';
  if (error.code === 'NETWORK_ERROR') return 'networkError';
  if (Number(error.statusCode) >= 500) return 'serverError';
  return 'generalError';
}

module.exports = {
  ClientError,
  messageKeyForError,
  normalizeRequestError,
};
