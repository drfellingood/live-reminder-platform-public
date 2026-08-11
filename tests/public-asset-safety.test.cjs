const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const blockedMediaExtensions = new Set([
  '.avif', '.bmp', '.eot', '.gif', '.ico', '.jpeg', '.jpg', '.mp3', '.mp4',
  '.ogg', '.otf', '.pdf', '.png', '.ttf', '.wav', '.webm', '.webp', '.woff', '.woff2',
]);

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

test('public source ships no unreviewed media or copied branding assets', () => {
  const publicFiles = walk(path.join(root, 'public'));
  const blocked = publicFiles.filter((file) => blockedMediaExtensions.has(path.extname(file).toLowerCase()));
  assert.deepEqual(blocked, []);

  const provenance = fs.readFileSync(path.join(root, 'docs', 'SOURCE_PROVENANCE.md'), 'utf8');
  assert.match(provenance, /contains no project-owned raster images/i);
  assert.match(provenance, /creator, creation method, permission, license/i);
});
