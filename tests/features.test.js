'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('public/index.html');
const app = read('public/app.js');
const server = read('server.js');

test('UI Parent mantiene video, stato e quattro azioni primarie', () => {
  for (const id of ['parentVideoFrame', 'parentLiveBadge', 'listenToggle', 'nightModeButton', 'fullscreenButton', 'pauseParentButton']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /Impostazioni/);
  assert.match(html, /Ultimi avvisi/);
});

test('aggiunta Parent è disponibile da Baby e da Impostazioni Dispositivi', () => {
  assert.match(html, /id="babyInviteButton"/);
  assert.match(html, /id="parentInviteButton"/);
  assert.match(html, />Dispositivi</);
  assert.match(html, /id="settingsParentCount">1 di 3 Parent collegati/);
  assert.match(app, /settingsParentCount'\)\.textContent = `\$\{label\} collegati`/);
  assert.match(app, /create-pairing/);
  assert.match(app, /state\.parents\.available <= 0/);
});

test('QR scanner supporta camera, BarcodeDetector e fallback jsQR/file', () => {
  assert.match(app, /BarcodeDetector/);
  assert.match(app, /jsQR/);
  assert.match(html, /id="qrImageInput"/);
  assert.match(app, /getUserMedia\(\{ video: \{ facingMode/);
  assert.match(app, /parseInvite/);
});

test('visione notturna supporta Auto, On, Off e luminanza locale', () => {
  assert.match(html, /value="auto">Auto/);
  assert.match(html, /value="on">Attiva/);
  assert.match(html, /value="off">Disattiva/);
  assert.match(app, /environment-status/);
  assert.match(app, /luminance < 52/);
  assert.match(read('public/styles.css'), /brightness\(1\.8\) contrast\(1\.22\)/);
});

test('media mantiene i vincoli anti-eco e audio Parent separato', () => {
  assert.match(app, /echoCancellation: true/);
  assert.match(app, /noiseSuppression: true/);
  assert.match(app, /autoGainControl: true/);
  assert.match(app, /channelCount: \{ ideal: 1 \}/);
  assert.match(html, /<audio id="remoteAudio" autoplay><\/audio>/);
  assert.match(app, /startAdaptiveVolume/);
});

test('rilevatori restano locali e sospendono il pianto con mic disattivo', () => {
  assert.match(app, /state\.detection\.cry/);
  assert.match(app, /state\.detection\.motion/);
  assert.match(app, /!audioTrack\.enabled/);
  assert.match(app, /detection-event/);
  assert.match(server, /const allowed = \['cry', 'motion'\]/);
});

test('multi-Parent usa peer separati e conserva riconnessione 30 secondi', () => {
  assert.match(app, /babyPeers: new Map\(\)/);
  assert.match(app, /createBabyPeer\(parentId\)/);
  assert.match(server, /RECONNECT_TTL_MS = 30 \* 1000/);
  assert.match(server, /MAX_PARENTS = 3/);
  assert.match(app, /parent-pause/);
  assert.match(app, /Riconnessione disponibile per/);
});

test('Wake Lock e media richiedono secure context senza bloccare browser non compatibili', () => {
  assert.match(app, /window\.isSecureContext/);
  assert.match(app, /'wakeLock' in navigator/);
  assert.match(app, /document\.visibilityState === 'visible'/);
  assert.match(app, /navigator\.mediaDevices\?\.getUserMedia/);
});

test('diagnostica include Parent, slot, inviti e luminanza senza token', () => {
  assert.match(server, /availableSlots/);
  assert.match(server, /activePairings/);
  assert.match(server, /environment: session\.environment/);
  const diagnosticsBlock = server.slice(server.indexOf("socket.on('diagnostics-request'"), server.indexOf("socket.on('disconnect'"));
  assert.doesNotMatch(diagnosticsBlock, /babyToken:/);
  assert.doesNotMatch(diagnosticsBlock, /parentToken:/);
});
