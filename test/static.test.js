'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

const server = read('server.js');
const app = read('public/app.js');
const detectors = read('public/detectors.js');
const sw = read('public/sw.js');
const html = read('public/index.html');
const pkg = JSON.parse(read('package.json'));
const manifest = JSON.parse(read('public/manifest.webmanifest'));

test('release version and PWA cache are consistent', () => {
  assert.equal(pkg.version, '1.1.2');
  assert.match(sw, /babymoon-v1\.1\.2/);
  assert.match(html, /app\.js\?v=1\.1\.2/);
  assert.equal(manifest.name, 'BabyMoon');
});

test('multi-Parent signaling has an explicit limit and isolated peer identifiers', () => {
  assert.match(server, /const MAX_PARENTS = 3/);
  assert.match(server, /parents: new Map\(\)/);
  assert.match(server, /targetParentId/);
  assert.match(server, /parentId: auth\.parent\.id/);
  assert.match(app, /babyPeers: new Map\(\)/);
  assert.match(app, /function createBabyPeer\(parentId\)/);
  assert.match(app, /function closeBabyPeer\(parentId\)/);
});

test('Interrompi and Termina sessione remain distinct', () => {
  assert.match(server, /socket\.on\('interrupt-parent'/);
  assert.match(server, /socket\.on\('end-session'/);
  assert.match(app, /data-action="interrupt-parent"/);
  assert.match(app, /Termina sessione/);
  assert.match(app, /data-action="reconnect-parent"/);
  assert.match(app, /Date\.now\(\) \+ 30_000/);
});

test('audio fixes and adaptive volume boundaries are present', () => {
  assert.match(app, /echoCancellation: \{ ideal: true \}/);
  assert.match(app, /noiseSuppression: \{ ideal: true \}/);
  assert.match(app, /autoGainControl: \{ ideal: true \}/);
  assert.match(app, /channelCount: \{ ideal: 1 \}/);
  assert.match(app, /Math\.max\(0\.22/);
  assert.match(app, /Math\.min\(0\.70/);
  assert.match(app, /set-baby-mic/);
});

test('detectors remain local and configurable', () => {
  assert.match(detectors, /class CryDetector/);
  assert.match(detectors, /class MotionDetector/);
  assert.match(app, /new window\.BabyMoonDetectors\.CryDetector/);
  assert.match(app, /new window\.BabyMoonDetectors\.MotionDetector/);
});

test('repository contains no embedded TURN credentials', () => {
  for (const file of ['server.js', 'public/app.js', '.env.example']) {
    const content = read(file);
    assert.doesNotMatch(content, /TURN_CREDENTIAL\s*=\s*[^\s#]+/i);
  }
});
