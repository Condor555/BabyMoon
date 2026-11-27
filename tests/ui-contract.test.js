'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);

test('HTML ids are unique', () => assert.equal(ids.length, new Set(ids).size));
test('all cached UI ids exist in HTML', () => {
  const block = app.match(/const ids = \[([\s\S]*?)\];/)[1];
  const expected = [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const missing = expected.filter((id) => !ids.includes(id));
  assert.deepEqual(missing, []);
});
test('Parent destructive action is per-Parent and global termination remains on Baby', () => {
  assert.match(html, /id="hangupParent"[\s\S]*?Interrompi/);
  assert.match(html, /id="parentEndCall"[\s\S]*?Termina su questo Parent/);
  assert.match(html, /id="endSession"[\s\S]*?Termina sessione/);
});
