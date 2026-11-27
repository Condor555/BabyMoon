'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const helmet = require('helmet');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { parentTarget, babyTargetForParent, detachParentSocket } = require('./lib/peer-routing');

const PORT = Number(process.env.PORT || 3000);
const MAX_PARENTS = 3;
const INVITE_TTL_MS = 5 * 60_000;
const RECONNECT_TTL_MS = 30_000;
const SESSION_TTL_MS = 12 * 60 * 60_000;
const secret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const production = process.env.NODE_ENV === 'production';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'", 'wss:', 'ws:'],
      workerSrc: ["'self'", 'blob:'],
      manifestSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use((req, res, next) => {
  if (production && req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(308, `https://${req.headers.host}${req.originalUrl}`);
  }
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), fullscreen=(self), display-capture=()');
  next();
});
app.use(express.json({ limit: '16kb' }));

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 64 * 1024,
  transports: ['websocket', 'polling'],
  pingInterval: 10_000,
  pingTimeout: 20_000
});

/** @type {Map<string, any>} */
const sessions = new Map();
const pinAttempts = new Map();

const randomId = (bytes = 18) => crypto.randomBytes(bytes).toString('base64url');
const digest = (value) => crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
const timingSafeHashEqual = (value, expectedHash) => {
  const actual = Buffer.from(digest(value));
  const expected = Buffer.from(String(expectedHash || ''));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};
const sanitizeId = (value, max = 128) => typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
const callback = (ack, payload) => typeof ack === 'function' && ack(payload);
const roomName = (sessionId) => `session:${sessionId}`;
const now = () => Date.now();

function publicBase(socket) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const origin = socket.handshake.headers.origin;
  if (origin && /^https?:\/\//i.test(origin)) return origin.replace(/\/$/, '');
  const proto = socket.handshake.headers['x-forwarded-proto'] || (production ? 'https' : 'http');
  const host = socket.handshake.headers['x-forwarded-host'] || socket.handshake.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function getIceServers() {
  const urls = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
    .split(',').map((v) => v.trim()).filter(Boolean);
  const servers = urls.length ? [{ urls }] : [];
  const turnUrls = (process.env.TURN_URLS || '').split(',').map((v) => v.trim()).filter(Boolean);
  if (turnUrls.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    servers.push({ urls: turnUrls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  }
  return servers;
}

function sessionSummary(session) {
  return {
    sessionId: session.id,
    parentCount: [...session.parents.values()].filter((p) => p.socketId).length,
    reservedParentCount: session.parents.size,
    maxParents: MAX_PARENTS,
    babyMicEnabled: session.babyMicEnabled,
    babyOnline: Boolean(session.baby.socketId)
  };
}

function emitPresence(session) {
  io.to(roomName(session.id)).emit('session:presence', sessionSummary(session));
}

function clearParentTimer(parent) {
  if (parent.cleanupTimer) clearTimeout(parent.cleanupTimer);
  parent.cleanupTimer = null;
}

function deleteParent(session, parentId, reason = 'expired') {
  const parent = session.parents.get(parentId);
  if (!parent) return;
  clearParentTimer(parent);
  if (parent.socketId) {
    const socket = io.sockets.sockets.get(parent.socketId);
    if (socket) {
      socket.leave(roomName(session.id));
      socket.data = { role: 'detached' };
      socket.emit('parent:ended', { reason });
    }
  }
  session.parents.delete(parentId);
  if (session.baby.socketId) io.to(session.baby.socketId).emit('parent:left', { parentId, reason, reconnectable: false });
  emitPresence(session);
}

function scheduleParentExpiry(session, parent, reason) {
  clearParentTimer(parent);
  parent.reconnectUntil = now() + RECONNECT_TTL_MS;
  parent.cleanupTimer = setTimeout(() => deleteParent(session, parent.id, 'reconnect-expired'), RECONNECT_TTL_MS + 250);
  if (session.baby.socketId) {
    io.to(session.baby.socketId).emit('parent:left', {
      parentId: parent.id,
      reason,
      reconnectable: true,
      reconnectUntil: parent.reconnectUntil
    });
  }
  emitPresence(session);
}

function endSession(session, reason = 'ended') {
  if (!session || session.ended) return;
  session.ended = true;
  if (session.expiryTimer) clearTimeout(session.expiryTimer);
  if (session.babyOfflineTimer) clearTimeout(session.babyOfflineTimer);
  for (const parent of session.parents.values()) clearParentTimer(parent);
  io.to(roomName(session.id)).emit('session:ended', { reason });
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.sessionId === session.id) {
      socket.leave(roomName(session.id));
      socket.data = { role: 'detached' };
    }
  }
  sessions.delete(session.id);
}

async function makeInvite(session, socket) {
  if (session.parents.size >= MAX_PARENTS) throw new Error('Limite di 3 Parent raggiunto');
  const inviteToken = randomId(24);
  let pin;
  do pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  while ([...sessions.values()].some((s) => [...s.invites.values()].some((i) => !i.used && i.expiresAt > now() && timingSafeHashEqual(pin, i.pinHash))));
  const inviteId = randomId(12);
  const expiresAt = now() + INVITE_TTL_MS;
  session.invites.set(inviteId, {
    id: inviteId,
    tokenHash: digest(inviteToken),
    pinHash: digest(pin),
    expiresAt,
    used: false,
    createdBy: socket.data.role,
    createdAt: now()
  });
  const url = `${publicBase(socket)}/?mode=parent&invite=${encodeURIComponent(inviteToken)}`;
  const qrDataUrl = await QRCode.toDataURL(url, { width: 360, margin: 1, errorCorrectionLevel: 'M' });
  return { inviteId, pin, inviteToken, expiresAt, url, qrDataUrl };
}

function findInvite({ inviteToken, pin }) {
  const value = sanitizeId(inviteToken, 256) || (typeof pin === 'string' && /^\d{6}$/.test(pin) ? pin : null);
  if (!value) return null;
  for (const session of sessions.values()) {
    for (const invite of session.invites.values()) {
      if (invite.used || invite.expiresAt <= now()) continue;
      const match = inviteToken ? timingSafeHashEqual(value, invite.tokenHash) : timingSafeHashEqual(value, invite.pinHash);
      if (match) return { session, invite };
    }
  }
  return null;
}

function rateLimitPair(socket) {
  const key = socket.handshake.address || socket.id;
  const entry = pinAttempts.get(key) || { count: 0, resetAt: now() + 60_000 };
  if (entry.resetAt <= now()) { entry.count = 0; entry.resetAt = now() + 60_000; }
  entry.count += 1;
  pinAttempts.set(key, entry);
  return entry.count <= 5;
}

function authenticatedSession(socket) {
  const session = sessions.get(socket.data.sessionId);
  return session && !session.ended ? session : null;
}

function authenticatedParent(socket, session) {
  if (!session || socket.data.role !== 'parent') return null;
  const parent = session.parents.get(socket.data.parentId);
  return parent && parent.socketId === socket.id ? parent : null;
}

function attachBabySocket(socket, session) {
  if (session.baby.socketId && session.baby.socketId !== socket.id) io.to(session.baby.socketId).emit('device:replaced');
  session.baby.socketId = socket.id;
  if (session.babyOfflineTimer) clearTimeout(session.babyOfflineTimer);
  session.babyOfflineTimer = null;
  socket.data = { role: 'baby', sessionId: session.id };
  socket.join(roomName(session.id));
}

function attachParentSocket(socket, session, parent) {
  clearParentTimer(parent);
  if (parent.socketId && parent.socketId !== socket.id) io.to(parent.socketId).emit('device:replaced');
  parent.socketId = socket.id;
  parent.reconnectUntil = null;
  socket.data = { role: 'parent', sessionId: session.id, parentId: parent.id };
  socket.join(roomName(session.id));
}

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'BabyMoon', version: '1.2.1' }));
app.get('/api/config', (_req, res) => res.json({ iceServers: getIceServers(), maxParents: MAX_PARENTS, reconnectSeconds: 30 }));
app.get('/vendor/jsqr.js', (_req, res) => res.sendFile(require.resolve('jsqr')));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: production ? '1h' : 0, etag: true }));
app.get('/*splat', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

io.on('connection', (socket) => {
  socket.data = { role: 'guest' };

  socket.on('baby:create', async (_payload, ack) => {
    try {
      const id = randomId(12);
      const babyToken = randomId(32);
      const session = {
        id,
        baby: { socketId: null, tokenHash: digest(babyToken) },
        parents: new Map(),
        invites: new Map(),
        babyMicEnabled: true,
        createdAt: now(),
        ended: false,
        expiryTimer: null,
        babyOfflineTimer: null
      };
      session.expiryTimer = setTimeout(() => endSession(session, 'expired'), SESSION_TTL_MS);
      sessions.set(id, session);
      attachBabySocket(socket, session);
      const invite = await makeInvite(session, socket);
      callback(ack, { ok: true, sessionId: id, babyToken, invite, iceServers: getIceServers(), summary: sessionSummary(session) });
      emitPresence(session);
    } catch (error) {
      callback(ack, { ok: false, error: error.message });
    }
  });

  socket.on('baby:resume', ({ sessionId, babyToken } = {}, ack) => {
    const session = sessions.get(sanitizeId(sessionId));
    if (!session || !timingSafeHashEqual(babyToken, session.baby.tokenHash)) return callback(ack, { ok: false, error: 'Sessione Baby non valida' });
    attachBabySocket(socket, session);
    callback(ack, { ok: true, summary: sessionSummary(session), iceServers: getIceServers() });
    for (const parent of session.parents.values()) {
      if (parent.socketId) {
        socket.emit('parent:ready', { parentId: parent.id, reason: 'baby-resumed' });
        io.to(parent.socketId).emit('baby:online', { sessionId: session.id });
      }
    }
    emitPresence(session);
  });

  socket.on('invite:create', async (_payload, ack) => {
    const session = authenticatedSession(socket);
    if (!session || !['baby', 'parent'].includes(socket.data.role)) return callback(ack, { ok: false, error: 'Non autorizzato' });
    try { callback(ack, { ok: true, invite: await makeInvite(session, socket), summary: sessionSummary(session) }); }
    catch (error) { callback(ack, { ok: false, error: error.message }); }
  });

  socket.on('invite:revoke', ({ inviteId } = {}, ack) => {
    const session = authenticatedSession(socket);
    const id = sanitizeId(inviteId);
    if (!session || !id || !['baby', 'parent'].includes(socket.data.role)) return callback(ack, { ok: false, error: 'Non autorizzato' });
    const invite = session.invites.get(id);
    if (invite) { invite.used = true; session.invites.delete(id); }
    callback(ack, { ok: true });
  });

  socket.on('parent:pair', ({ inviteToken, pin } = {}, ack) => {
    if (!rateLimitPair(socket)) return callback(ack, { ok: false, error: 'Troppi tentativi. Attendi un minuto.' });
    const found = findInvite({ inviteToken, pin });
    if (!found) return callback(ack, { ok: false, error: 'Invito non valido o scaduto' });
    const { session, invite } = found;
    if (session.parents.size >= MAX_PARENTS) return callback(ack, { ok: false, error: 'Limite di 3 Parent raggiunto' });
    invite.used = true;
    const parentId = randomId(12);
    const parentToken = randomId(32);
    const parent = { id: parentId, tokenHash: digest(parentToken), socketId: null, reconnectUntil: null, cleanupTimer: null, joinedAt: now() };
    session.parents.set(parentId, parent);
    attachParentSocket(socket, session, parent);
    callback(ack, { ok: true, sessionId: session.id, parentId, parentToken, iceServers: getIceServers(), summary: sessionSummary(session) });
    if (session.baby.socketId) io.to(session.baby.socketId).emit('parent:ready', { parentId, reason: 'paired' });
    emitPresence(session);
  });

  socket.on('parent:resume', ({ sessionId, parentId, parentToken } = {}, ack) => {
    const session = sessions.get(sanitizeId(sessionId));
    const parent = session?.parents.get(sanitizeId(parentId));
    if (!session || !parent || !timingSafeHashEqual(parentToken, parent.tokenHash)) return callback(ack, { ok: false, error: 'Sessione Parent non valida' });
    if (parent.reconnectUntil && parent.reconnectUntil < now()) {
      deleteParent(session, parent.id, 'reconnect-expired');
      return callback(ack, { ok: false, error: 'Finestra di riconnessione scaduta' });
    }
    attachParentSocket(socket, session, parent);
    callback(ack, { ok: true, iceServers: getIceServers(), summary: sessionSummary(session) });
    if (session.baby.socketId) io.to(session.baby.socketId).emit('parent:ready', { parentId: parent.id, reason: 'resumed' });
    emitPresence(session);
  });

  socket.on('parent:leave', (_payload, ack) => {
    const session = authenticatedSession(socket);
    const parent = authenticatedParent(socket, session);
    if (!parent) return callback(ack, { ok: false, error: 'Parent non autorizzato' });
    if (!detachParentSocket(session, parent.id, socket.id)) return callback(ack, { ok: false, error: 'Parent non autorizzato' });
    socket.leave(roomName(session.id));
    socket.data = { role: 'detached', sessionId: session.id, parentId: parent.id };
    scheduleParentExpiry(session, parent, 'parent-hangup');
    callback(ack, { ok: true, reconnectUntil: parent.reconnectUntil });
  });

  socket.on('parent:end', (_payload, ack) => {
    const session = authenticatedSession(socket);
    const parent = authenticatedParent(socket, session);
    if (!parent) return callback(ack, { ok: false, error: 'Parent non autorizzato' });
    callback(ack, { ok: true });
    deleteParent(session, parent.id, 'parent-ended');
  });

  socket.on('session:end', (_payload, ack) => {
    const session = authenticatedSession(socket);
    if (!session || socket.data.role !== 'baby' || session.baby.socketId !== socket.id) {
      return callback(ack, { ok: false, error: 'Solo il Baby può terminare l’intera sessione' });
    }
    callback(ack, { ok: true });
    endSession(session, 'baby-ended');
  });

  socket.on('webrtc:offer', ({ parentId, negotiationId, description } = {}, ack) => {
    const session = authenticatedSession(socket);
    const parent = session?.parents.get(sanitizeId(parentId));
    if (!session || socket.data.role !== 'baby' || !parent?.socketId || !sanitizeId(negotiationId) || description?.type !== 'offer' || typeof description.sdp !== 'string') {
      return callback(ack, { ok: false, error: 'Offerta non autorizzata' });
    }
    const targetSocketId = parentTarget(session, parent.id);
    if (!targetSocketId) return callback(ack, { ok: false, error: 'Parent offline' });
    io.to(targetSocketId).emit('webrtc:offer', { parentId: parent.id, negotiationId, description });
    callback(ack, { ok: true });
  });

  socket.on('webrtc:answer', ({ parentId, negotiationId, description } = {}, ack) => {
    const session = authenticatedSession(socket);
    const parent = authenticatedParent(socket, session);
    if (!parent || parent.id !== parentId || !session.baby.socketId || !sanitizeId(negotiationId) || description?.type !== 'answer' || typeof description.sdp !== 'string') {
      return callback(ack, { ok: false, error: 'Risposta non autorizzata' });
    }
    const targetSocketId = babyTargetForParent(session, parent.id, socket.id);
    if (!targetSocketId) return callback(ack, { ok: false, error: 'Baby offline' });
    io.to(targetSocketId).emit('webrtc:answer', { parentId: parent.id, negotiationId, description });
    callback(ack, { ok: true });
  });

  socket.on('webrtc:ice', ({ parentId, negotiationId, candidate } = {}, ack) => {
    const session = authenticatedSession(socket);
    const id = sanitizeId(parentId);
    if (!session || !id || !sanitizeId(negotiationId)) return callback(ack, { ok: false, error: 'ICE non autorizzato' });
    if (candidate !== null && (typeof candidate !== 'object' || typeof candidate.candidate !== 'string')) return callback(ack, { ok: false, error: 'Candidate non valido' });
    if (socket.data.role === 'baby') {
      const parent = session.parents.get(id);
      if (!parent?.socketId) return callback(ack, { ok: false, error: 'Parent offline' });
      const targetSocketId = parentTarget(session, id);
      if (!targetSocketId) return callback(ack, { ok: false, error: 'Parent offline' });
      io.to(targetSocketId).emit('webrtc:ice', { parentId: id, negotiationId, candidate });
    } else {
      const parent = authenticatedParent(socket, session);
      if (!parent || parent.id !== id || !session.baby.socketId) return callback(ack, { ok: false, error: 'Parent non autorizzato' });
      const targetSocketId = babyTargetForParent(session, id, socket.id);
      if (!targetSocketId) return callback(ack, { ok: false, error: 'Baby offline' });
      io.to(targetSocketId).emit('webrtc:ice', { parentId: id, negotiationId, candidate });
    }
    callback(ack, { ok: true });
  });

  socket.on('webrtc:restart', ({ parentId, reason } = {}, ack) => {
    const session = authenticatedSession(socket);
    const parent = authenticatedParent(socket, session);
    if (!parent || parent.id !== parentId || !session.baby.socketId) return callback(ack, { ok: false, error: 'Restart non autorizzato' });
    io.to(session.baby.socketId).emit('webrtc:restart', { parentId, reason: sanitizeId(reason, 64) || 'requested' });
    callback(ack, { ok: true });
  });

  socket.on('talkback:state', ({ enabled } = {}, ack) => {
    const session = authenticatedSession(socket);
    const parent = authenticatedParent(socket, session);
    if (!parent || !session.baby.socketId || typeof enabled !== 'boolean') return callback(ack, { ok: false, error: 'Comando non autorizzato' });
    io.to(session.baby.socketId).emit('talkback:state', { parentId: parent.id, enabled });
    callback(ack, { ok: true });
  });

  socket.on('baby-mic:set', ({ enabled } = {}, ack) => {
    const session = authenticatedSession(socket);
    const parent = authenticatedParent(socket, session);
    if (!parent || !session.baby.socketId || typeof enabled !== 'boolean') return callback(ack, { ok: false, error: 'Comando non autorizzato' });
    io.to(session.baby.socketId).emit('baby-mic:set', { enabled, requestedBy: parent.id });
    callback(ack, { ok: true });
  });

  socket.on('baby-mic:state', ({ enabled } = {}, ack) => {
    const session = authenticatedSession(socket);
    if (!session || socket.data.role !== 'baby' || typeof enabled !== 'boolean') return callback(ack, { ok: false, error: 'Stato non autorizzato' });
    session.babyMicEnabled = enabled;
    io.to(roomName(session.id)).emit('baby-mic:state', { enabled });
    callback(ack, { ok: true });
  });

  socket.on('detector:event', ({ type, level } = {}, ack) => {
    const session = authenticatedSession(socket);
    if (!session || socket.data.role !== 'baby' || !['cry', 'motion'].includes(type)) return callback(ack, { ok: false, error: 'Evento non autorizzato' });
    socket.to(roomName(session.id)).emit('detector:event', { type, level: Number(level) || 0, at: now() });
    callback(ack, { ok: true });
  });

  socket.on('disconnect', (reason) => {
    const session = sessions.get(socket.data.sessionId);
    if (!session || session.ended) return;
    if (socket.data.role === 'baby' && session.baby.socketId === socket.id) {
      session.baby.socketId = null;
      io.to(roomName(session.id)).emit('baby:offline', { reconnectUntil: now() + RECONNECT_TTL_MS });
      session.babyOfflineTimer = setTimeout(() => endSession(session, 'baby-offline-timeout'), RECONNECT_TTL_MS + 250);
      emitPresence(session);
      return;
    }
    if (socket.data.role === 'parent') {
      const parent = session.parents.get(socket.data.parentId);
      if (parent && parent.socketId === socket.id) {
        parent.socketId = null;
        scheduleParentExpiry(session, parent, reason || 'socket-disconnect');
      }
    }
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`BabyMoon v1.2.1 listening on http://localhost:${PORT}`));
}

module.exports = { app, server, io, sessions, constants: { MAX_PARENTS, RECONNECT_TTL_MS, INVITE_TTL_MS } };
