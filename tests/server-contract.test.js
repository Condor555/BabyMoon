'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSettings, getIceServers } = require('../lib/config.js');

test('normalizza impostazioni non valide con default sicuri', () => {
  assert.deepEqual(normalizeSettings({ crySensitivity: 'extreme', motionCooldown: 999 }), {
    cryEnabled: true,
    motionEnabled: true,
    crySensitivity: 'medium',
    motionSensitivity: 'medium',
    cryCooldown: 45,
    motionCooldown: 15
  });
});

test('accetta soltanto sensibilità e cooldown previsti', () => {
  const result = normalizeSettings({ cryEnabled: false, motionEnabled: false, crySensitivity: 'high', motionSensitivity: 'low', cryCooldown: 60, motionCooldown: 10 });
  assert.equal(result.cryEnabled, false);
  assert.equal(result.motionEnabled, false);
  assert.equal(result.crySensitivity, 'high');
  assert.equal(result.motionSensitivity, 'low');
  assert.equal(result.cryCooldown, 60);
  assert.equal(result.motionCooldown, 10);
});

test('STUN è sempre configurato e TURN è opzionale', () => {
  const servers = getIceServers();
  assert.ok(servers.length >= 2);
  assert.ok(servers.some(item => String(item.urls).includes('stun:')));
});
