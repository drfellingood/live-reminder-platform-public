const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const ignored = new Set(['.git', '.data', 'dist', 'node_modules']);

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && ignored.has(entry.name)) return [];
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(target) : [target];
  });
}

test('runtime secrets, local data, private keys, and release archives are ignored', () => {
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  for (const pattern of [
    /^\.data\/$/m,
    /^\.env$/m,
    /^\.env\.\*$/m,
    /^\*\.pem$/m,
    /^\*\.key$/m,
    /^\*\.p12$/m,
    /^\*\.pfx$/m,
    /^\*\.sqlite$/m,
    /^\*\.sqlite-\*$/m,
    /^\*\.db$/m,
    /^\*\.db-\*$/m,
    /^\*\.zip$/m,
    /^\*\.tgz$/m,
    /^\*\.tar\.gz$/m,
    /^\*\.bak$/m,
    /^\.DS_Store$/m,
    /^Thumbs\.db$/m,
  ]) {
    assert.match(ignore, pattern);
  }
});

test('the public tree exposes only the documented runtime module roots', () => {
  for (const directory of ['adapters', 'core', 'server', 'sources', 'src']) {
    assert.equal(fs.statSync(path.join(root, directory)).isDirectory(), true, directory);
  }
});

test('example configuration contains no populated secret', () => {
  const example = fs.readFileSync(path.join(root, 'server', 'self-hosted.env.example'), 'utf8');
  for (const name of ['ADMIN_PASSWORD_HASH', 'ADMIN_SESSION_SECRET', 'OBSERVATION_SECRET', 'OPERATOR_SECRET']) {
    assert.match(example, new RegExp(`^${name}=$`, 'm'));
  }
  assert.doesNotMatch(example, /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/);
});

test('browser bundles never contain server secret variable names', () => {
  const browserSource = listFiles(path.join(root, 'src'))
    .filter((file) => ['.js', '.jsx'].includes(path.extname(file)))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  assert.doesNotMatch(browserSource, /ADMIN_PASSWORD_HASH|ADMIN_SESSION_SECRET|OBSERVATION_SECRET|OPERATOR_SECRET|DELIVERY_WEBHOOK_BEARER_TOKEN/);
});

test('filenames are portable ASCII paths', () => {
  const relativePaths = listFiles(root).map((file) => path.relative(root, file).replaceAll('\\', '/'));
  for (const relativePath of relativePaths) {
    assert.match(relativePath, /^[\x20-\x7e]+$/, relativePath);
  }
});
