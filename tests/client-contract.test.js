'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');

test('Parent non richiede getUserMedia', () => {
  const join = app.slice(app.indexOf('async function joinParent'), app.indexOf('function joinError'));
  assert.doesNotMatch(join, /getUserMedia/);
});

test('audio Parent usa un elemento dedicato e play nel gesto', () => {
  assert.match(app, /id=\"remote-audio\"/);
  const unlock = app.slice(app.indexOf('async function unlockAudio'), app.indexOf('async function startDetectors'));
  assert.match(unlock, /await audio\.play\(\)/);
});

test('Baby è unico offerer WebRTC', () => {
  const offer = app.slice(app.indexOf('async function startOffer'), app.indexOf('async function handleSignal'));
  assert.match(offer, /state\.role !== 'baby'/);
  assert.match(offer, /createOffer/);
});

test('eventi di rilevamento sono autorizzati al ruolo Baby', () => {
  assert.match(server, /authorize\(socket, socket\.data\.sessionId, 'baby'\)/);
  assert.match(server, /payload\.type === 'cry'/);
  assert.match(server, /payload\.type === 'motion'/);
});

test('cache PWA è versionata V1.1.0', () => {
  assert.match(sw, /babymoon-v1\.1\.0/);
  assert.match(sw, /detectors\.js\?v=1\.1\.0/);
});

test('Termina è sincronizzato tramite server', () => {
  assert.match(app, /emitAck\('end-session'/);
  assert.match(server, /io\.to\(session\.id\)\.emit\('session-ended'/);
});
