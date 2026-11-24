'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let createAppServer;
let Client;
let available = true;
try {
  ({ createAppServer } = require('../server'));
  ({ io: Client } = require('socket.io-client'));
} catch (_error) {
  available = false;
}

function once(socket, event, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout ${event}`)), timeout);
    socket.once(event, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

function ack(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

test('three Parents are isolated, reconnect independently, and share global Baby state', { skip: !available }, async () => {
  const service = createAppServer({ publicUrl: 'https://example.test', reconnectWindowMs: 180, cleanupMs: 20 });
  await new Promise((resolve) => service.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = service.httpServer.address();
  const url = `http://127.0.0.1:${port}`;
  const clients = Array.from({ length: 5 }, () => Client(url, { transports: ['websocket'], forceNew: true }));
  const [baby, p1, p2, p3, p4] = clients;

  try {
    await Promise.all(clients.map((client) => once(client, 'connect')));
    const created = await ack(baby, 'create-session', {});
    assert.equal(created.ok, true);

    const pair = async (client) => ack(client, 'pair-session', { pin: created.pin });
    const r1 = await pair(p1);
    const r2 = await pair(p2);
    const r3 = await pair(p3);
    assert.equal(new Set([r1.parentId, r2.parentId, r3.parentId]).size, 3);
    const refused = await pair(p4);
    assert.equal(refused.code, 'PARENT_LIMIT');

    const babySignal = once(baby, 'signal');
    p1.emit('signal', {
      role: 'parent', sessionId: created.sessionId, parentId: r1.parentId, token: r1.parentToken,
      negotiationId: 'n-parent-1', signal: { candidate: { candidate: 'p1' } }
    });
    assert.equal((await babySignal).parentId, r1.parentId);

    const p2Signal = once(p2, 'signal');
    let p1Unexpected = false;
    p1.once('signal', () => { p1Unexpected = true; });
    baby.emit('signal', {
      role: 'baby', sessionId: created.sessionId, token: created.babyToken,
      targetParentId: r2.parentId, negotiationId: 'n-parent-2', signal: { candidate: { candidate: 'baby-to-p2' } }
    });
    const routed = await p2Signal;
    assert.equal(routed.parentId, r2.parentId);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(p1Unexpected, false);

    const p1State = once(p1, 'baby-state');
    const p2State = once(p2, 'baby-state');
    const p3State = once(p3, 'baby-state');
    baby.emit('baby-state', {
      role: 'baby', sessionId: created.sessionId, token: created.babyToken,
      micEnabled: false, cryAvailable: false
    });
    assert.deepEqual(await Promise.all([p1State, p2State, p3State]), [
      { micEnabled: false, cryAvailable: false },
      { micEnabled: false, cryAvailable: false },
      { micEnabled: false, cryAvailable: false }
    ]);

    const interrupted = await ack(p1, 'interrupt-parent', {
      role: 'parent', sessionId: created.sessionId, parentId: r1.parentId, token: r1.parentToken
    });
    assert.equal(interrupted.ok, true);
    const resumed = await ack(p1, 'resume-session', {
      role: 'parent', sessionId: created.sessionId, parentId: r1.parentId, token: r1.parentToken
    });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.parentId, r1.parentId);

    const expired = once(p3, 'parent-session-ended');
    await ack(p3, 'interrupt-parent', {
      role: 'parent', sessionId: created.sessionId, parentId: r3.parentId, token: r3.parentToken
    });
    assert.equal((await expired).reason, 'reconnect-window-expired');

    const babyEnded = once(baby, 'session-ended');
    const p1Ended = once(p1, 'session-ended');
    const p2Ended = once(p2, 'session-ended');
    const ended = await ack(p2, 'end-session', {
      role: 'parent', sessionId: created.sessionId, parentId: r2.parentId, token: r2.parentToken
    });
    assert.equal(ended.ok, true);
    await Promise.all([babyEnded, p1Ended, p2Ended]);
  } finally {
    for (const client of clients) client.close();
    await service.close();
  }
});
