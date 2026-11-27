'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
let Client;
try { ({ io: Client } = require('socket.io-client')); } catch (_error) { /* skipped without npm install */ }

function once(socket, event, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeout);
    socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
  });
}
function ack(socket, event, payload = {}) {
  return new Promise((resolve, reject) => socket.timeout(3000).emit(event, payload, (error, result) => error ? reject(error) : result?.ok ? resolve(result) : reject(new Error(result?.error))));
}

test('2 Parents join sequentially, receive isolated signaling, and one leaves without affecting the other', { skip: !Client }, async (t) => {
  process.env.PORT = '0'; process.env.NODE_ENV = 'test'; process.env.SESSION_SECRET = 'integration-test-secret-that-is-long-enough';
  const { server, io } = require('../server');
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];
  const connect = async () => {
    const socket = Client(url, { transports: ['websocket'], forceNew: true }); sockets.push(socket); await once(socket, 'connect'); return socket;
  };
  t.after(async () => { sockets.forEach((socket) => socket.disconnect()); await new Promise((resolve) => io.close(resolve)); server.close(); });

  const baby = await connect();
  const created = await ack(baby, 'baby:create');
  const parent1 = await connect();
  const ready1Promise = once(baby, 'parent:ready');
  const paired1 = await ack(parent1, 'parent:pair', { inviteToken: created.invite.inviteToken });
  const ready1 = await ready1Promise;
  assert.equal(ready1.parentId, paired1.parentId);

  const offer1Promise = once(parent1, 'webrtc:offer');
  await ack(baby, 'webrtc:offer', { parentId: paired1.parentId, negotiationId: 'neg-parent-1', description: { type: 'offer', sdp: 'offer-one' } });
  assert.equal((await offer1Promise).negotiationId, 'neg-parent-1');

  const secondInvite = await ack(parent1, 'invite:create');
  const parent2 = await connect();
  const ready2Promise = once(baby, 'parent:ready');
  const paired2 = await ack(parent2, 'parent:pair', { inviteToken: secondInvite.invite.inviteToken });
  assert.notEqual(paired1.parentId, paired2.parentId);
  assert.equal((await ready2Promise).parentId, paired2.parentId);

  let parent1UnexpectedOffer = false;
  parent1.once('webrtc:offer', () => { parent1UnexpectedOffer = true; });
  const offer2Promise = once(parent2, 'webrtc:offer');
  await ack(baby, 'webrtc:offer', { parentId: paired2.parentId, negotiationId: 'neg-parent-2', description: { type: 'offer', sdp: 'offer-two' } });
  assert.equal((await offer2Promise).negotiationId, 'neg-parent-2');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(parent1UnexpectedOffer, false, 'Parent 2 offer leaked to Parent 1');

  const answer1Promise = once(baby, 'webrtc:answer');
  await ack(parent1, 'webrtc:answer', { parentId: paired1.parentId, negotiationId: 'neg-parent-1', description: { type: 'answer', sdp: 'answer-one' } });
  assert.equal((await answer1Promise).parentId, paired1.parentId);

  const leftPromise = once(baby, 'parent:left');
  await ack(parent2, 'parent:leave');
  assert.equal((await leftPromise).parentId, paired2.parentId);

  const stillLiveOffer = once(parent1, 'webrtc:offer');
  await ack(baby, 'webrtc:offer', { parentId: paired1.parentId, negotiationId: 'neg-parent-1b', description: { type: 'offer', sdp: 'offer-one-still-live' } });
  assert.equal((await stillLiveOffer).negotiationId, 'neg-parent-1b');
});
