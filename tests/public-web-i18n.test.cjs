const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const sourceRoot = path.resolve(__dirname, '..', 'src');
const app = fs.readFileSync(path.join(sourceRoot, 'App.jsx'), 'utf8');
const admin = fs.readFileSync(path.join(sourceRoot, 'AdminDashboard.jsx'), 'utf8');

test('the public preview and admin console default to English and provide a Chinese switch', () => {
  assert.match(app, /useState\('en'\)/);
  assert.match(admin, /useState\('en'\)/);
  assert.match(app, /language:\s*'中文'/);
  assert.match(admin, /language:\s*'中文'/);
  assert.match(app, /虚构界面预览/);
  assert.match(admin, /运营控制台/);
  assert.match(app, /language === 'en' \? 'zh' : 'en'/);
});

test('both languages state the sender-versus-handset evidence boundary', () => {
  assert.match(app, /Handset display remains unverified/);
  assert.match(app, /手机是否展示仍未验证/);
  assert.match(admin, /It does not confirm that a handset displayed a notification/);
  assert.match(admin, /不代表手机已经展示通知/);
});

test('navigation labels are present in both language dictionaries', () => {
  for (const label of ['Monitor', 'Channels', 'Inbox', 'Activity', 'Settings']) assert.match(app, new RegExp(label));
  for (const label of ['监控', '频道', '收件箱', '活动', '设置']) assert.match(app, new RegExp(label));
});
