'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { io: createClient } = require('socket.io-client');
const { createBabyMoonServer, parseIceServers } = require('../server');

let instance;
let baseUrl;
const clients = [];

function connectClient() {
  return new Promise((resolve, reject) => {
    const socket = createClient(baseUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      timeout: 3_000
    });
    clients.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function emitAck(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(3_000).emit(event, payload, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

function once(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

before(async () => {
  instance = createBabyMoonServer({
    env: { NODE_ENV: 'test', PUBLIC_URL: 'https://babymoon.test' },
    logger: { error() {}, warn() {}, log() {} }
  });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${instance.server.address().port}`;
});

after(async () => {
  for (const client of clients) client.disconnect();
  await instance.close();
});

test('ICE configuration contains public STUN and no TURN without credentials', async () => {
  const response = await fetch(`${baseUrl}/api/ice-config`);
  assert.equal(response.status, 200);
  const config = await response.json();
  assert.equal(config.turnConfigured, false);
  assert.ok(config.iceServers.flatMap((item) => item.urls).some((url) => url.startsWith('stun:')));
  assert.ok(!config.iceServers.flatMap((item) => item.urls).some((url) => url.startsWith('turn:')));
});

test('TURN is appended only when all authenticated values are present', () => {
  const stunOnly = parseIceServers({ TURN_URLS: 'turn:turn.example.test:3478' });
  assert.equal(stunOnly.length, 2);
  const withTurn = parseIceServers({
    TURN_URLS: 'turn:turn.example.test:3478,turns:turn.example.test:443',
    TURN_USERNAME: 'temporary-user',
    TURN_CREDENTIAL: 'temporary-password'
  });
  assert.equal(withTurn.length, 3);
  assert.equal(withTurn[2].username, 'temporary-user');
  assert.equal(withTurn[2].urls.length, 2);
});

test('Baby creates a session, Parent pairs once, and signaling is relayed', async () => {
  const baby = await connectClient();
  const parent = await connectClient();
  const created = await emitAck(baby, 'create-session');
  assert.equal(created.ok, true);
  assert.match(created.pin, /^\d{6}$/);
  assert.match(created.joinUrl, /^https:\/\/babymoon\.test\/\?join=/);
  assert.match(created.qrDataUrl, /^data:image\/png;base64,/);

  const joined = await emitAck(parent, 'join-session', { pin: created.pin });
  assert.equal(joined.ok, true);
  assert.equal(joined.sessionId, created.sessionId);
  assert.equal(joined.role, 'parent');

  const secondParent = await connectClient();
  const duplicate = await emitAck(secondParent, 'join-session', { pin: created.pin });
  assert.equal(duplicate.ok, false);

  const incoming = once(parent, 'signal');
  const negotiationId = 'negotiation_12345';
  const relayAck = await emitAck(baby, 'signal', {
    type: 'offer',
    negotiationId,
    sdp: { type: 'offer', sdp: 'v=0\r\n' }
  });
  assert.equal(relayAck.ok, true);
  const signal = await incoming;
  assert.equal(signal.type, 'offer');
  assert.equal(signal.negotiationId, negotiationId);
  assert.equal(signal.from, 'baby');
});

test('either role can terminate the session for both peers', async () => {
  const baby = await connectClient();
  const parent = await connectClient();
  const created = await emitAck(baby, 'create-session');
  const joined = await emitAck(parent, 'join-session', {
    sessionId: created.sessionId,
    pairingToken: new URL(created.joinUrl).searchParams.get('token')
  });
  assert.equal(joined.ok, true);

  const babyEnded = once(baby, 'session-ended');
  const parentEnded = once(parent, 'session-ended');
  const ack = await emitAck(parent, 'end-session');
  assert.equal(ack.ok, true);
  assert.match((await babyEnded).reason, /^ended-by-parent$/);
  assert.match((await parentEnded).reason, /^ended-by-parent$/);

  const resume = await emitAck(baby, 'resume-session', {
    sessionId: created.sessionId,
    resumeToken: created.resumeToken,
    role: 'baby'
  });
  assert.equal(resume.ok, false);
});
