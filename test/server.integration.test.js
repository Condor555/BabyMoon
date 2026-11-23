import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
    } catch (_error) {
      // Server is still starting.
    }
    await sleep(100);
  }
  throw new Error('Server did not become healthy.');
}

async function createSession(baseUrl) {
  const response = await fetch(`${baseUrl}/api/session`, { method: 'POST' });
  assert.equal(response.status, 201);
  return response.json();
}

class SocketIoPollingClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.sid = null;
    this.nextAckId = 0;
    this.acks = new Map();
    this.events = [];
  }

  get endpoint() {
    const suffix = this.sid ? `&sid=${encodeURIComponent(this.sid)}` : `&t=${Date.now()}-${Math.random()}`;
    return `${this.baseUrl}/socket.io/?EIO=4&transport=polling${suffix}`;
  }

  async connect() {
    const handshake = await fetch(this.endpoint).then((response) => response.text());
    assert.ok(handshake.startsWith('0'), `Unexpected Engine.IO handshake: ${handshake}`);
    this.sid = JSON.parse(handshake.slice(1)).sid;
    await this.post('40');
    await this.waitForPacket((packet) => packet.startsWith('40'));
  }

  async post(packet) {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: packet,
    });
    assert.ok(response.ok, `Engine.IO POST failed: ${response.status}`);
  }

  async poll(timeout = 2_000) {
    let response;
    try {
      response = await fetch(this.endpoint, { signal: AbortSignal.timeout(timeout) });
    } catch (error) {
      if (error.name === 'TimeoutError') return [];
      throw error;
    }
    assert.ok(response.ok, `Engine.IO poll failed: ${response.status}`);
    const body = await response.text();
    const packets = body.split('\x1e').filter(Boolean);
    for (const packet of packets) await this.consume(packet);
    return packets;
  }

  async consume(packet) {
    if (packet === '2') {
      await this.post('3');
      return;
    }
    if (packet.startsWith('43')) {
      const match = packet.match(/^43(\d+)(.*)$/s);
      if (!match) return;
      const payload = JSON.parse(match[2]);
      this.acks.set(Number(match[1]), payload[0]);
      return;
    }
    if (packet.startsWith('42')) {
      const payload = JSON.parse(packet.slice(2));
      this.events.push({ name: payload[0], data: payload[1] });
    }
  }

  async waitForPacket(predicate, timeout = 5_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const packets = await this.poll(Math.min(1_000, deadline - Date.now()));
      const matching = packets.find(predicate);
      if (matching) return matching;
    }
    throw new Error('Timed out waiting for Socket.IO packet.');
  }

  async emitAck(name, data, timeout = 5_000) {
    const id = this.nextAckId;
    this.nextAckId += 1;
    const payload = data === undefined ? [name] : [name, data];
    await this.post(`42${id}${JSON.stringify(payload)}`);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.acks.has(id)) {
        const ack = this.acks.get(id);
        this.acks.delete(id);
        return ack;
      }
      await this.poll(Math.min(1_000, deadline - Date.now()));
    }
    throw new Error(`Timed out waiting for ack of ${name}.`);
  }

  async waitForEvent(name, timeout = 5_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const index = this.events.findIndex((event) => event.name === name);
      if (index >= 0) return this.events.splice(index, 1)[0].data;
      await this.poll(Math.min(1_000, deadline - Date.now()));
    }
    throw new Error(`Timed out waiting for event ${name}.`);
  }
}

test('BabyMoon V1.0.1 server, pairing, signaling, termination and limits', async (t) => {
  const port = 41_000 + Math.floor(Math.random() * 2_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      PUBLIC_URL: baseUrl,
      TURN_URLS: 'turn:turn.example.test:3478?transport=udp,turns:turn.example.test:5349',
      TURN_USERNAME: 'temporary-user',
      TURN_CREDENTIAL: 'temporary-credential',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverErrors = '';
  server.stderr.on('data', (chunk) => { serverErrors += chunk; });
  t.after(() => server.kill('SIGTERM'));

  const health = await waitForHealth(baseUrl);
  assert.deepEqual(health, { ok: true, service: 'BabyMoon', version: '1.0.1' });

  const home = await fetch(baseUrl);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.match(home.headers.get('permissions-policy') || '', /camera=\(self\)/);

  const config = await fetch(`${baseUrl}/api/config`).then((response) => response.json());
  assert.equal(config.iceServers.length, 3);
  assert.equal(config.iceServers[2].username, 'temporary-user');

  // PIN pairing path.
  const pinSession = await createSession(baseUrl);
  assert.match(pinSession.code, /^\d{6}$/);
  assert.match(pinSession.token, /^[a-f0-9]{64}$/);
  assert.match(pinSession.qr, /^data:image\/png;base64,/);
  assert.equal(new URL(pinSession.pairingUrl).searchParams.get('code'), pinSession.code);
  assert.match(new URL(pinSession.pairingUrl).searchParams.get('pair'), /^[A-Za-z0-9_-]{40,128}$/);

  const baby = new SocketIoPollingClient(baseUrl);
  const parent = new SocketIoPollingClient(baseUrl);
  await baby.connect();
  await parent.connect();
  assert.equal((await baby.emitAck('join', { code: pinSession.code, role: 'baby', token: pinSession.token })).ok, true);
  const parentJoin = await parent.emitAck('join', { code: pinSession.code, role: 'parent', source: 'pin' });
  assert.equal(parentJoin.ok, true);
  assert.match(parentJoin.participantToken, /^[a-f0-9]{64}$/);
  await baby.waitForEvent('parent-ready');

  const offer = { description: { type: 'offer', sdp: 'v=0\r\n' } };
  assert.equal((await baby.emitAck('signal', offer)).ok, true);
  assert.deepEqual(await parent.waitForEvent('signal'), { payload: offer });

  const answer = { description: { type: 'answer', sdp: 'v=0\r\n' } };
  assert.equal((await parent.emitAck('signal', answer)).ok, true);
  assert.deepEqual(await baby.waitForEvent('signal'), { payload: answer });

  assert.equal((await parent.emitAck('request-reconnect')).ok, true);
  await baby.waitForEvent('retry-request');

  const intruder = new SocketIoPollingClient(baseUrl);
  await intruder.connect();
  const intruderJoin = await intruder.emitAck('join', { code: pinSession.code, role: 'parent', source: 'pin' });
  assert.equal(intruderJoin.ok, false);
  assert.match(intruderJoin.error, /già associata|già collegato/i);

  assert.equal((await parent.emitAck('end-session')).ok, true);
  assert.equal((await baby.waitForEvent('session-ended')).reason, 'user');
  assert.equal((await parent.waitForEvent('session-ended')).reason, 'user');

  // Strong-token QR pairing path and authenticated HTTP termination fallback.
  const qrSession = await createSession(baseUrl);
  const qrToken = new URL(qrSession.pairingUrl).searchParams.get('pair');
  const qrBaby = new SocketIoPollingClient(baseUrl);
  const qrParent = new SocketIoPollingClient(baseUrl);
  await qrBaby.connect();
  await qrParent.connect();
  assert.equal((await qrBaby.emitAck('join', { code: qrSession.code, role: 'baby', token: qrSession.token })).ok, true);
  const qrJoin = await qrParent.emitAck('join', {
    code: qrSession.code,
    role: 'parent',
    source: 'qr',
    pairingToken: qrToken,
  });
  assert.equal(qrJoin.ok, true);
  assert.match(qrJoin.participantToken, /^[a-f0-9]{64}$/);

  const endResponse = await fetch(`${baseUrl}/api/session/${qrSession.code}/end`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'parent', token: qrJoin.participantToken }),
  });
  assert.equal(endResponse.status, 200);
  assert.equal((await qrBaby.waitForEvent('session-ended')).reason, 'user');
  assert.equal((await qrParent.waitForEvent('session-ended')).reason, 'user');

  // The one-time session can no longer be joined.
  const expiredJoin = await intruder.emitAck('join', { code: qrSession.code, role: 'parent', source: 'qr', pairingToken: qrToken });
  assert.equal(expiredJoin.ok, false);
  assert.match(expiredJoin.error, /non valida|scaduta/i);

  // One prior intruder failure + one expired-session failure + three more failures = lock; next request is blocked.
  for (let index = 0; index < 3; index += 1) {
    const result = await intruder.emitAck('join', { code: `99${index}999`, role: 'parent', source: 'pin' });
    assert.equal(result.ok, false);
  }
  const rateLimited = await intruder.emitAck('join', { code: '123456', role: 'parent', source: 'pin' });
  assert.equal(rateLimited.ok, false);
  assert.match(rateLimited.error, /Troppi tentativi/i);

  assert.equal(server.exitCode, null, serverErrors);
});
