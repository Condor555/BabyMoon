'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');

test('Baby is the sole WebRTC offerer and Parent is receive-only', () => {
  assert.match(app, /state\.mode !== 'baby'/);
  assert.match(app, /addTransceiver\('video', \{ direction: 'recvonly' \}\)/);
  assert.match(app, /addTransceiver\('audio', \{ direction: 'recvonly' \}\)/);
  assert.match(app, /if \(state\.mode !== 'parent' \|\| payload\.from !== 'baby'\) return/);
});

test('ICE candidates are queued until a remote description exists', () => {
  assert.match(app, /candidateQueues: new Map\(\)/);
  assert.match(app, /!state\.pc\?\.remoteDescription/);
  assert.match(app, /flushCandidateQueue/);
  assert.match(app, /end-of-candidates/);
});

test('connection recovery uses bounded backoff and ICE restarts', () => {
  assert.match(app, /RETRY_DELAYS = \[0, 2_000, 5_000, 10_000, 30_000, 60_000\]/);
  assert.match(app, /createOffer\(\{ iceRestart: Boolean\(forceRestart\) \}\)/);
  assert.match(app, /resume-session/);
});

test('Parent never requests camera or microphone', () => {
  const acquireFunction = app.slice(app.indexOf('async function acquireBabyMedia'), app.indexOf('async function startBabyMode'));
  assert.match(acquireFunction, /getUserMedia/);
  const joinFunction = app.slice(app.indexOf('async function joinParent'), app.indexOf('function handlePresence'));
  assert.doesNotMatch(joinFunction, /getUserMedia/);
});

test('PWA and UI are versioned consistently', () => {
  assert.match(app, /VERSION = '1\.0\.3'/);
  assert.match(html, /app\.js\?v=1\.0\.3/);
  assert.match(sw, /babymoon-v1\.0\.3/);
});
