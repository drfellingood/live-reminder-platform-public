const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('the administration UI authenticates and reads only the aggregate dashboard endpoint', () => {
  const component = source('src/AdminDashboard.jsx');
  assert.match(component, /\/api\/admin-login/);
  assert.match(component, /\/api\/admin-dashboard/);
  assert.match(component, /\/api\/admin-logout/);
  assert.match(component, /credentials:\s*'same-origin'/);
  assert.match(component, /cache:\s*'no-store'/);
  assert.doesNotMatch(component, /dashboard\.recipients|recipientId/);
  assert.doesNotMatch(component, /receipts\.map|eligibleRecipientIds/);
});

test('the operational view renders summary, channel eligibility, event reconciliation, and the handset boundary', () => {
  const component = source('src/AdminDashboard.jsx');
  for (const field of [
    'summary.broadcasters',
    'summary.recipients',
    'summary.accepted',
    'summary.ambiguous',
    'summary.bookkeepingPending',
    'item.activeSubscriptions',
    'item.currentlyEligibleRecipients',
    'item.denominator',
    'counts.countConsistent',
    'counts.terminal',
  ]) assert.match(component, new RegExp(field.replace('.', '\\.')));
  assert.match(component, /Handset display remains unverified/);
  assert.match(component, /手机已经展示通知/);
  assert.match(component, /terminal:\s*'Processing complete'/);
  assert.match(component, /terminal:\s*'处理完毕'/);
  assert.doesNotMatch(component, /counts\.terminal === true \? 'flag flag--ok'/);
});

test('the login and dashboard surfaces preserve keyboard, form, table, and live-error semantics', () => {
  const component = source('src/AdminDashboard.jsx');
  assert.match(component, /<label htmlFor="admin-password">/);
  assert.match(component, /autoComplete="current-password"/);
  assert.match(component, /role="alert"/);
  assert.match(component, /<table>/);
  assert.match(component, /aria-labelledby=/);
  assert.match(component, /type="button"/);
  assert.doesNotMatch(component, /<img\b|backgroundImage|url\(/i);
});

test('the admin stylesheet is responsive, focus-visible, and uses system fonts', () => {
  const base = source('src/styles.css');
  const admin = source('src/admin-dashboard.css');
  assert.match(base, /-apple-system/);
  assert.match(base, /focus-visible/);
  assert.match(admin, /@media \(max-width: 720px\)/);
  assert.match(admin, /overflow-x: auto/);
  assert.doesNotMatch(admin, /@import|https?:\/\//i);
});
