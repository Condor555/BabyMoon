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

test('Parent audio uses a dedicated media element unlocked by a direct user gesture', () => {
  assert.match(html, /<video id="remoteVideo" autoplay muted playsinline>/);
  assert.match(html, /<audio id="remoteAudio" playsinline preload="auto"/);
  assert.match(app, /remoteAudioStream: new MediaStream\(\)/);
  assert.match(app, /remoteTrack\.kind === 'audio' \? state\.remoteAudioStream : state\.remoteStream/);
  const toggleFunction = app.slice(app.indexOf('function toggleAudio'), app.indexOf('async function toggleFullscreen'));
  assert.match(toggleFunction, /startRemoteAudio\(true\)/);
  const startFunction = app.slice(app.indexOf('function startRemoteAudio'), app.indexOf('function toggleAudio'));
  assert.match(startFunction, /elements\.remoteAudio\.play\(\)/);
});

test('media diagnostics count inbound audio and video bytes', () => {
  assert.match(app, /report\.type === 'inbound-rtp'/);
  assert.match(app, /state\.inboundBytes\[kind\] = Number\(report\.bytesReceived\)/);
});

test('PWA and UI are versioned consistently', () => {
  assert.match(app, /VERSION = '1\.0\.4'/);
  assert.match(html, /app\.js\?v=1\.0\.4/);
  assert.match(sw, /babymoon-v1\.0\.4/);
});
