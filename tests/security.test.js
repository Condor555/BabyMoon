'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function mockDependencies(request, parent, isMain) {
  if (request === 'express') {
    const express = () => ({});
    express.static = () => () => {};
    return express;
  }
  if (request === 'socket.io') return { Server: class Server {} };
  if (request === 'qrcode') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { SessionRegistry, SlidingWindowLimiter, constants } = require('../server.js');
Module._load = originalLoad;

function registryAt(initial = 1_000_000) {
  let now = initial;
  const registry = new SessionRegistry(() => now);
  return { registry, setNow: (value) => { now = value; }, tick: (value) => { now += value; } };
}

test('invito è separato dal token Baby ed è consumabile una sola volta', () => {
  const { registry } = registryAt();
  const session = registry.createSession('baby-socket');
  const invite = registry.createInvite(session, { role: 'baby', id: 'baby-socket' });
  assert.notEqual(invite.secret, session.babyToken);
  assert.equal(invite.pin.length, 6);
  assert.equal(registry.consumeInvite({ inviteKey: `${invite.id}.${invite.secret}` }).session.id, session.id);
  assert.throws(() => registry.consumeInvite({ inviteKey: `${invite.id}.${invite.secret}` }), /CONSUMED_INVITE/);
});

test('PIN e QR puntano allo stesso invito monouso', () => {
  const { registry } = registryAt();
  const session = registry.createSession('baby');
  const invite = registry.createInvite(session, { role: 'parent', id: 'p1' });
  const result = registry.consumeInvite({ pin: invite.pin });
  assert.equal(result.invite.id, invite.id);
  assert.throws(() => registry.consumeInvite({ inviteKey: `${invite.id}.${invite.secret}` }), /CONSUMED_INVITE/);
});

test('invito scade dopo la finestra breve', () => {
  const { registry, tick } = registryAt();
  const session = registry.createSession('baby');
  const invite = registry.createInvite(session, { role: 'baby', id: 'baby' });
  tick(constants.INVITE_TTL_MS + 1);
  assert.throws(() => registry.consumeInvite({ pin: invite.pin }), /EXPIRED_INVITE/);
});

test('invito revocato non può essere consumato', () => {
  const { registry } = registryAt();
  const session = registry.createSession('baby');
  const invite = registry.createInvite(session, { role: 'baby', id: 'baby' });
  assert.equal(registry.revokeInvite(session, invite.id), true);
  assert.throws(() => registry.consumeInvite({ inviteKey: `${invite.id}.${invite.secret}` }), /REVOKED_INVITE/);
});

test('ogni Parent riceve token distinto e il limite totale è 3', () => {
  const { registry } = registryAt();
  const session = registry.createSession('baby');
  const parents = [1, 2, 3].map((number) => registry.addParent(session, `socket-${number}`));
  assert.equal(new Set(parents.map((parent) => parent.token)).size, 3);
  assert.equal(registry.parentCount(session), 3);
  assert.equal(registry.slots(session), 0);
  assert.throws(() => registry.addParent(session, 'socket-4'), /PARENT_LIMIT/);
  assert.throws(() => registry.createInvite(session, { role: 'parent', id: parents[0].id }), /PARENT_LIMIT/);
});

test('Parent disconnesso conserva lo slot per 30 secondi e può riconnettersi', () => {
  const { registry, tick } = registryAt();
  const session = registry.createSession('baby');
  const parent = registry.addParent(session, 'socket-1');
  registry.disconnectParent(session, parent.id);
  assert.equal(registry.parentCount(session), 1);
  tick(constants.RECONNECT_TTL_MS - 1);
  assert.ok(registry.reconnect(session, parent.id, parent.token, 'socket-2'));
  assert.equal(session.parents.get(parent.id).socketId, 'socket-2');
});

test('token Parent errato non può riconnettersi', () => {
  const { registry } = registryAt();
  const session = registry.createSession('baby');
  const parent = registry.addParent(session, 'socket-1');
  registry.disconnectParent(session, parent.id);
  assert.equal(registry.reconnect(session, parent.id, 'token-errato', 'socket-2'), null);
});

test('rate limiter applica limite e si resetta fuori finestra', () => {
  const limiter = new SlidingWindowLimiter(2, 1000);
  assert.equal(limiter.take('key', 0), true);
  assert.equal(limiter.take('key', 1), true);
  assert.equal(limiter.take('key', 2), false);
  assert.equal(limiter.take('key', 1001), true);
});
