const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'src', 'App.jsx'), 'utf8');
const entry = fs.readFileSync(path.join(root, 'src', 'main.jsx'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('the interface preview contains exactly five neutral top-level pages', () => {
  const navigationBlock = app.match(/const NAVIGATION = Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.ok(navigationBlock);
  const ids = [...navigationBlock[1].matchAll(/id:\s*'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(ids, ['monitor', 'channels', 'inbox', 'activity', 'settings']);
  assert.match(app, /role="tablist"/);
  assert.match(app, /aria-selected=/);
});

test('preview fixtures are clearly fictional and have no account or delivery connection', () => {
  assert.match(app, /Fictional interface preview/);
  assert.match(app, /Presentation data only/);
  assert.match(app, /no account, recipient, status endpoint, or delivery connection/);
  assert.match(app, /demo-channel-a/);
  assert.doesNotMatch(app, /<img\b|\.png|\.jpe?g|\.webp|logo/i);
});

test('line icons come from the declared component library and the app/admin split is pathname based', () => {
  assert.match(app, /from '@tabler\/icons-react'/);
  assert.match(entry, /window\.location\.pathname/);
  assert.match(entry, /<AdminDashboard \/>/);
  assert.match(entry, /<App \/>/);
  assert.doesNotMatch(html, /<img\b|https?:\/\//i);
  assert.equal((html.match(/<script\b/g) || []).length, 1);
});
