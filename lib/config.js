'use strict';

function getIceServers(env = process.env) {
  const servers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:global.stun.twilio.com:3478' }
  ];
  const urls = String(env.TURN_URLS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (urls.length && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    servers.push({ urls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
  }
  return servers;
}

function normalizeSettings(input = {}) {
  const sensitivity = ['low', 'medium', 'high'];
  return {
    cryEnabled: input.cryEnabled !== false,
    motionEnabled: input.motionEnabled !== false,
    crySensitivity: sensitivity.includes(input.crySensitivity) ? input.crySensitivity : 'medium',
    motionSensitivity: sensitivity.includes(input.motionSensitivity) ? input.motionSensitivity : 'medium',
    cryCooldown: [30, 45, 60].includes(Number(input.cryCooldown)) ? Number(input.cryCooldown) : 45,
    motionCooldown: [10, 15, 20].includes(Number(input.motionCooldown)) ? Number(input.motionCooldown) : 15
  };
}

module.exports = { getIceServers, normalizeSettings };
