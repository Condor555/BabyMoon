'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const manifest = JSON.parse(read('public/manifest.webmanifest'));

function pngDimensions(file) {
  const data = fs.readFileSync(path.join(root, file));
  assert.equal(data.toString('ascii', 1, 4), 'PNG');
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

test('manifest definisce identità e avvio standalone nello scope root', () => {
  assert.equal(manifest.id, '/');
  assert.equal(manifest.scope, '/');
  assert.match(manifest.start_url, /^\//);
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, '#080d1d');
  assert.equal(manifest.background_color, '#070b18');
});

test('manifest include icone installabili any e maskable 192/512', () => {
  for (const size of [192, 512]) {
    const any = manifest.icons.find((icon) => icon.sizes === `${size}x${size}` && icon.purpose === 'any');
    const maskable = manifest.icons.find((icon) => icon.sizes === `${size}x${size}` && icon.purpose === 'maskable');
    assert.ok(any, `icona any ${size}`);
    assert.ok(maskable, `icona maskable ${size}`);
    assert.deepEqual(pngDimensions(any.src.replace(/^\//, 'public/')), { width: size, height: size });
    assert.deepEqual(pngDimensions(maskable.src.replace(/^\//, 'public/')), { width: size, height: size });
  }
});

test('Apple touch icon è 180x180 e dichiarata nell HTML', () => {
  assert.deepEqual(pngDimensions('public/icons/apple-touch-icon-180.png'), { width: 180, height: 180 });
  assert.match(read('public/index.html'), /rel="apple-touch-icon"[^>]+180x180/);
});

test('HTML include meta iOS, viewport safe e manifest', () => {
  const html = read('public/index.html');
  assert.match(html, /apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /apple-mobile-web-app-status-bar-style" content="black-translucent"/);
  assert.match(html, /apple-mobile-web-app-title" content="BabyMoon"/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
});

test('CSS usa safe-area e regole standalone', () => {
  const css = read('public/styles.css');
  assert.match(css, /env\(safe-area-inset-top/);
  assert.match(css, /env\(safe-area-inset-bottom/);
  assert.match(css, /@media \(display-mode: standalone\)/);
});

test('service worker versione 1.2 precachea shell e non intercetta API o Socket.IO', () => {
  const sw = read('public/sw.js');
  assert.match(sw, /babymoon-v1\.2\.0/);
  assert.match(sw, /\/manifest\.webmanifest/);
  assert.match(sw, /icon-maskable-512\.png/);
  assert.match(sw, /url\.pathname\.startsWith\('\/socket\.io\/'\)/);
  assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(sw, /request\.mode === 'navigate'/);
  assert.match(sw, /self\.clients\.claim/);
});

test('PWA onboarding gestisce Chromium, installazione e iOS senza prompt invasivi', () => {
  const app = read('public/app.js');
  assert.match(app, /beforeinstallprompt/);
  assert.match(app, /appinstalled/);
  assert.match(app, /navigator\.standalone/);
  assert.match(app, /Condividi, poi “Aggiungi alla schermata Home”/);
  assert.match(app, /babymoon-install-dismissed/);
  assert.match(app, /7 \* 24 \* 60 \* 60 \* 1000/);
});
