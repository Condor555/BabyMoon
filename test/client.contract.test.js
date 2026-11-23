import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appPath = new URL('../public/app.js', import.meta.url);

async function source() {
  return readFile(appPath, 'utf8');
}

test('client uses stable delegated controls and no implicit DOM globals', async () => {
  const code = await source();
  assert.doesNotMatch(code, /\.(onclick|oninput|ontouch|onpointer)\s*=/);
  assert.match(code, /app\.addEventListener\('click'/);
  assert.match(code, /app\.addEventListener\('pointerup'/);
  assert.match(code, /app\.addEventListener\('touchend'/);

  for (const action of [
    'switch-camera',
    'dark-screen',
    'wake-screen',
    'toggle-audio',
    'fullscreen',
    'retry',
    'end-session',
  ]) {
    assert.match(code, new RegExp(`data-action=["']${action}["']`));
    assert.match(code, new RegExp(`case ["']${action}["']`));
  }
});

test('client contract covers audio/video, autoplay fallback and clean WebRTC retries', async () => {
  const code = await source();
  assert.match(code, /getUserMedia\([\s\S]*audio:/);
  assert.match(code, /peer\.addTrack\(track, state\.localStream\)/);
  assert.match(code, /peer\.ontrack = receiveRemoteTrack/);
  assert.match(code, /video\.srcObject = state\.remoteStream/);
  assert.match(code, /Avvia video e audio/);
  assert.match(code, /video\.muted = false/);
  assert.match(code, /RETRY_DELAYS = \[0, 2_000, 5_000, 10_000, 30_000, 60_000\]/);
  assert.match(code, /closePeer\(\);[\s\S]*createAndSendOffer\(\{ restart: true \}\)/);
  assert.match(code, /session-ended/);
  assert.match(code, /if \(!state\.mode \|\| state\.ending/);
  assert.match(code, /waitForIceGathering\(peer\)/);
  assert.match(code, /negotiationId/);
  assert.match(code, /candidate\.toJSON/);
  assert.match(code, /Timeout ICE/);
  assert.match(code, /Non è configurato un server TURN/);
});

test('client contract covers mobile lifecycle, Wake Lock and getStats watchdog', async () => {
  const code = await source();
  assert.match(code, /navigator\.wakeLock\.request\('screen'\)/);
  assert.match(code, /peer\.getStats\(\)/);
  assert.match(code, /Watchdog: stream senza traffico multimediale/);
  assert.match(code, /visibilitychange/);
  assert.match(code, /window\.addEventListener\('online'/);
  assert.match(code, /window\.addEventListener\('offline'/);
  assert.match(code, /window\.addEventListener\('pageshow'/);
});

test('QR and PIN converge on the same authenticated Parent join flow', async () => {
  const code = await source();
  assert.match(code, /joinParent\(input\.value, element\.dataset\.source \|\| 'pin'\)/);
  assert.match(code, /arrivedFromQr \? 'qr' : 'pin'/);
  assert.match(code, /pairingToken: state\.mode === 'parent'/);
  assert.match(code, /participantToken/);
  assert.match(code, /sessionStorage\.setItem/);
});
