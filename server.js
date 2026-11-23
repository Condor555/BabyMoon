'use strict';

const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { getIceServers, normalizeSettings } = require('./lib/config');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = String(process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SESSION_TTL_MS = 5 * 60 * 60 * 1000;
const PAIR_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_SIGNAL_BYTES = 96 * 1024;

const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      mediaSrc: ["'self'", 'blob:'],
      workerSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  setHeaders(res, file) {
    if (file.endsWith('sw.js') || file.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'BabyMoon', version: '1.1.0' }));
app.get('/api/config', (_req, res) => res.json({ version: '1.1.0', iceServers: getIceServers(), turnConfigured: Boolean(process.env.TURN_URLS) }));
app.get('/*splat', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: MAX_SIGNAL_BYTES,
  pingInterval: 10000,
  pingTimeout: 20000,
  cors: { origin: false }
});

const sessions = new Map();
const attempts = new Map();

function randomToken() { return crypto.randomBytes(32).toString('base64url'); }
function pin() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
function id() { return crypto.randomUUID(); }
function safeAck(ack, payload) { if (typeof ack === 'function') ack(payload); }
function publicSession(session) {
  return { sessionId: session.id, pin: session.pin, pairToken: session.pairToken, expiresAt: session.pairExpiresAt, iceServers: getIceServers() };
}
function authorize(socket, sessionId, role) {
  const session = sessions.get(sessionId);
  if (!session || session.ended || socket.data.sessionId !== sessionId || socket.data.role !== role) return null;
  const side = session[role];
  if (!side || side.socketId !== socket.id) return null;
  return session;
}
function bind(socket, session, role, token) {
  socket.data.sessionId = session.id;
  socket.data.role = role;
  socket.data.token = token;
  session[role].socketId = socket.id;
  session[role].connectedAt = Date.now();
  socket.join(session.id);
}
function finishSession(session, reason = 'terminated') {
  if (!session || session.ended) return;
  session.ended = true;
  io.to(session.id).emit('session-ended', { reason });
  io.in(session.id).socketsLeave(session.id);
  setTimeout(() => sessions.delete(session.id), 1000);
}
function attemptKey(socket, value) { return `${socket.handshake.address}:${String(value || '').slice(0, 64)}`; }
function canAttempt(socket, value) {
  const key = attemptKey(socket, value);
  const record = attempts.get(key) || { count: 0, resetAt: Date.now() + 10 * 60 * 1000 };
  if (record.resetAt < Date.now()) { record.count = 0; record.resetAt = Date.now() + 10 * 60 * 1000; }
  record.count += 1;
  attempts.set(key, record);
  return record.count <= MAX_ATTEMPTS;
}
function findSession({ pin: requestedPin, pairToken }) {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (session.ended || session.parent) continue;
    if (pairToken && session.pairToken === pairToken && session.pairExpiresAt > now) return session;
    if (requestedPin && session.pin === requestedPin && session.pairExpiresAt > now) return session;
  }
  return null;
}

io.on('connection', socket => {
  socket.on('create-session', async (_payload, ack) => {
    if (socket.data.sessionId) return safeAck(ack, { ok: false, error: 'already-bound' });
    const session = {
      id: id(), pin: pin(), pairToken: randomToken(), pairExpiresAt: Date.now() + PAIR_TTL_MS,
      createdAt: Date.now(), ended: false, settings: normalizeSettings(),
      baby: { token: randomToken(), socketId: null }, parent: null, lastDetectionAt: { cry: 0, motion: 0 }
    };
    sessions.set(session.id, session);
    bind(socket, session, 'baby', session.baby.token);
    const pairUrl = `${PUBLIC_URL}/?pair=${encodeURIComponent(session.pairToken)}`;
    let qrDataUrl = '';
    try { qrDataUrl = await QRCode.toDataURL(pairUrl, { margin: 1, width: 280, color: { dark: '#0b1020', light: '#ffffff' } }); } catch (_) {}
    safeAck(ack, { ok: true, ...publicSession(session), token: session.baby.token, pairUrl, qrDataUrl });
  });

  socket.on('join-session', (payload = {}, ack) => {
    const requestedPin = String(payload.pin || '').replace(/\D/g, '').slice(0, 6);
    const pairToken = String(payload.pairToken || '').slice(0, 128);
    if (!canAttempt(socket, requestedPin || pairToken)) return safeAck(ack, { ok: false, error: 'too-many-attempts' });
    const session = findSession({ pin: requestedPin, pairToken });
    if (!session) return safeAck(ack, { ok: false, error: 'session-not-found' });
    if (session.parent) return safeAck(ack, { ok: false, error: 'parent-already-connected' });
    session.parent = { token: randomToken(), socketId: null };
    session.pin = null;
    session.pairToken = null;
    bind(socket, session, 'parent', session.parent.token);
    io.to(session.baby.socketId).emit('peer-ready', { role: 'parent' });
    safeAck(ack, { ok: true, sessionId: session.id, token: session.parent.token, iceServers: getIceServers(), settings: session.settings });
  });

  socket.on('resume-session', (payload = {}, ack) => {
    const session = sessions.get(String(payload.sessionId || ''));
    const role = payload.role === 'baby' ? 'baby' : payload.role === 'parent' ? 'parent' : '';
    const side = session && role ? session[role] : null;
    const suppliedToken = Buffer.from(String(payload.token || ''));
    const expectedToken = Buffer.from(String(side?.token || ''));
    const tokenMatches = suppliedToken.length === expectedToken.length && suppliedToken.length > 0 && crypto.timingSafeEqual(suppliedToken, expectedToken);
    if (!session || session.ended || !side || !tokenMatches) {
      return safeAck(ack, { ok: false, error: 'session-not-available' });
    }
    bind(socket, session, role, side.token);
    socket.to(session.id).emit('peer-resumed', { role });
    safeAck(ack, { ok: true, iceServers: getIceServers(), settings: session.settings, peerConnected: Boolean(session[role === 'baby' ? 'parent' : 'baby']?.socketId) });
  });

  socket.on('signal', payload => {
    if (!payload || typeof payload !== 'object') return;
    const role = socket.data.role;
    const session = authorize(socket, socket.data.sessionId, role);
    if (!session || JSON.stringify(payload).length > MAX_SIGNAL_BYTES) return;
    socket.to(session.id).emit('signal', { ...payload, from: role });
  });

  socket.on('detector-settings', (payload, ack) => {
    const session = authorize(socket, socket.data.sessionId, 'parent');
    if (!session) return safeAck(ack, { ok: false, error: 'unauthorized' });
    session.settings = normalizeSettings(payload);
    io.to(session.baby.socketId).emit('detector-settings', session.settings);
    safeAck(ack, { ok: true, settings: session.settings });
  });

  socket.on('detection', (payload = {}, ack) => {
    const session = authorize(socket, socket.data.sessionId, 'baby');
    const type = payload.type === 'cry' ? 'cry' : payload.type === 'motion' ? 'motion' : '';
    if (!session || !type) return safeAck(ack, { ok: false, error: 'unauthorized' });
    const cooldown = type === 'cry' ? session.settings.cryCooldown : session.settings.motionCooldown;
    if (Date.now() - session.lastDetectionAt[type] < cooldown * 1000) return safeAck(ack, { ok: false, error: 'cooldown' });
    session.lastDetectionAt[type] = Date.now();
    const event = { id: id(), type, at: Date.now(), confidence: Math.max(0, Math.min(1, Number(payload.confidence) || 0)) };
    if (session.parent?.socketId) io.to(session.parent.socketId).emit('detection', event);
    safeAck(ack, { ok: true });
  });

  socket.on('heartbeat', (_payload, ack) => {
    const session = authorize(socket, socket.data.sessionId, socket.data.role);
    safeAck(ack, { ok: Boolean(session), at: Date.now() });
  });

  socket.on('end-session', (_payload, ack) => {
    const session = authorize(socket, socket.data.sessionId, socket.data.role);
    if (!session) return safeAck(ack, { ok: false });
    safeAck(ack, { ok: true });
    finishSession(session, 'terminated');
  });

  socket.on('disconnect', () => {
    const session = sessions.get(socket.data.sessionId);
    if (!session || session.ended) return;
    const role = socket.data.role;
    if (session[role]?.socketId === socket.id) session[role].socketId = null;
    socket.to(session.id).emit('peer-disconnected', { role });
  });
});

setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) if (session.ended || now - session.createdAt > SESSION_TTL_MS) finishSession(session, 'expired');
  for (const [key, value] of attempts) if (value.resetAt < now) attempts.delete(key);
}, 60000).unref();

if (require.main === module) server.listen(PORT, () => console.log(`BabyMoon 1.1.0 http://localhost:${PORT}`));
module.exports = { app, server, io, normalizeSettings, getIceServers };
