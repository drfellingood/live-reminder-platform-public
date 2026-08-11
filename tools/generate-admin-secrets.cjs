const crypto = require('node:crypto');
const { hashAdminPassword } = require('../server/admin-server.cjs');

function independentSecret(bytes = 36) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function generateAdminSecrets() {
  const adminPassword = `admin-${independentSecret(24)}`;
  return Object.freeze({
    ADMIN_PASSWORD: adminPassword,
    ADMIN_PASSWORD_HASH: hashAdminPassword(adminPassword),
    ADMIN_SESSION_SECRET: independentSecret(),
    OBSERVATION_SECRET: independentSecret(),
    OPERATOR_SECRET: independentSecret(),
    CLIENT_IDENTITY_SECRET: independentSecret(),
  });
}

function printAdminSecrets(values = generateAdminSecrets(), output = process.stdout, diagnostics = process.stderr) {
  for (const name of [
    'ADMIN_PASSWORD',
    'ADMIN_PASSWORD_HASH',
    'ADMIN_SESSION_SECRET',
    'OBSERVATION_SECRET',
    'OPERATOR_SECRET',
    'CLIENT_IDENTITY_SECRET',
  ]) {
    output.write(`${name}=${values[name]}\n`);
  }
  diagnostics.write('ADMIN_PASSWORD_HASH is derived from ADMIN_PASSWORD. Session, observation, operator, and client-identity secrets are generated independently and must not be reused.\n');
  diagnostics.write('Store these values in a private secret manager. The plaintext administrator password is shown only in this output.\n');
}

if (require.main === module) printAdminSecrets();

module.exports = {
  generateAdminSecrets,
  printAdminSecrets,
};
