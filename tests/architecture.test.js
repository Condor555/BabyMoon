'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

function occurrences(source, pattern) { return [...source.matchAll(pattern)].length; }

test('Baby uses a Map of independent Parent peer contexts', () => {
  assert.match(app, /peers:\s*new Map\(\)/);
  assert.match(app, /state\.baby\.peers\.set\(parentId, peer\)/);
  assert.match(app, /state\.baby\.peers\.get\(parentId\)/);
  assert.match(app, /state\.baby\.peers\.delete\(parentId\)/);
  assert.doesNotMatch(app, /state\.baby\.pc\s*=/);
});

test('every Baby peer sends audio and video and receives talkback', () => {
  assert.match(app, /addTransceiver\(audioTrack,\s*\{\s*direction:\s*'sendonly'/);
  assert.match(app, /addTransceiver\(videoTrack,\s*\{\s*direction:\s*'sendonly'/);
  assert.match(app, /addTransceiver\('audio',\s*\{\s*direction:\s*'recvonly'/);
});

test('signaling is routed and validated by parentId and negotiationId', () => {
  for (const name of ['webrtc:offer','webrtc:answer','webrtc:ice']) assert.ok(occurrences(server, new RegExp(name.replace(':','\\:'),'g')) >= 2, `${name} missing`);
  assert.match(server, /parent\.id !== parentId/);
  assert.match(app, /peer\.negotiationId !== negotiationId/);
  assert.match(app, /parentId !== state\.parent\.parentId/);
});

test('one Parent hang-up is isolated and does not end the session', () => {
  const leaveBlock = server.slice(server.indexOf("socket.on('parent:leave'"), server.indexOf("socket.on('session:end'"));
  assert.match(leaveBlock, /detachParentSocket\(session, parent\.id, socket\.id\)/);
  assert.match(leaveBlock, /scheduleParentExpiry\(session, parent/);
  assert.doesNotMatch(leaveBlock, /endSession\(/);
  assert.match(server, /Solo il Baby può terminare l’intera sessione/);
  const endBlock = server.slice(server.indexOf("socket.on('parent:end'"), server.indexOf("socket.on('session:end'"));
  assert.match(endBlock, /deleteParent\(session, parent\.id, 'parent-ended'\)/);
  assert.doesNotMatch(endBlock, /endSession\(/);
});

test('Parent fullscreen has standard, WebKit, video, and CSS fallbacks', () => {
  assert.match(app, /target\.requestFullscreen/);
  assert.match(app, /target\.webkitRequestFullscreen/);
  assert.match(app, /remoteVideo\.webkitEnterFullscreen/);
  assert.match(app, /ios-fullscreen/);
  assert.match(html, /id="fullscreenParent"/);
});

test('talkback obtains Parent microphone only on demand and replaces its dedicated sender track', () => {
  assert.match(app, /async function toggleTalkback/);
  assert.match(app, /getUserMedia\(\{\s*video:\s*false/);
  assert.match(app, /talkbackTransceiver\.sender\.replaceTrack/);
  assert.match(app, /echoCancellation:\s*true/);
  assert.match(server, /socket\.on\('talkback:state'/);
});

test('second Parent can be invited by Baby or an authenticated Parent', () => {
  assert.match(server, /\['baby', 'parent'\]\.includes\(socket\.data\.role\)/);
  assert.match(html, /id="babyAddParent"/);
  assert.match(html, /id="parentAddParent"/);
});

test('stale ICE and answers are ignored per negotiation', () => {
  assert.match(app, /peer\.negotiationId !== negotiationId/);
  assert.match(app, /negotiationId === state\.parent\.negotiationId/);
  assert.match(app, /iceQueue:\s*\[\]/);
  assert.match(app, /flushIce/);
});
