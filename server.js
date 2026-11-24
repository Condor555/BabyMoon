'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const helmet = require('helmet');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const VERSION = '1.1.2';
const MAX_PARENTS = 3;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const RECONNECT_WINDOW_MS = 30 * 1000;
const MAX_PAIR_ATTEMPTS = 5;
const BLOCK_MS = 10 * 60 * 1000;
const CLEANUP_MS = 1000;
const VALID_SENSITIVITY = new Set(['low', 'medium', 'high']);
const DEFAULT_SETTINGS = Object.freeze({
  cryEnabled: true,
  motionEnabled: true,
  sensitivity: 'medium',
  cooldownSeconds: 30
});

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function normalizePin(pin) {
  return String(pin || '').replace(/\D/g, '').slice(0, 6);
}

function sanitizeSettings(input = {}) {
  const sensitivity = VALID_SENSITIVITY.has(input.sensitivity) ? input.sensitivity : DEFAULT_SETTINGS.sensitivity;
  const cooldown = Number(input.cooldownSeconds);
  return {
    cryEnabled: input.cryEnabled !== false,
    motionEnabled: input.motionEnabled !== false,
    sensitivity,
    cooldownSeconds: Number.isFinite(cooldown)
      ? Math.min(300, Math.max(10, Math.round(cooldown)))
      : DEFAULT_SETTINGS.cooldownSeconds
  };
}

function getClientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  return String(forwarded ? forwarded.split(',')[0] : socket.handshake.address || 'unknown').trim();
}

function createAppServer(options = {}) {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    transports: ['websocket', 'polling'],
    pingInterval: 20_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 1e6
  });
  const sessions = new Map();
  const pairAttempts = new Map();
  const publicDir = path.join(__dirname, 'public');
  const configuredPublicUrl = String(options.publicUrl || process.env.PUBLIC_URL || '').replace(/\/$/, '');
  const reconnectWindowMs = Number(options.reconnectWindowMs) || RECONNECT_WINDOW_MS;
  const cleanupMs = Number(options.cleanupMs) || CLEANUP_MS;

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        workerSrc: ["'self'", 'blob:'],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' }
  }));

  app.get('/api/health', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, name: 'BabyMoon', version: VERSION, activeSessions: sessions.size, maxParents: MAX_PARENTS });
  });

  app.get('/api/config', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      version: VERSION,
      maxParents: MAX_PARENTS,
      reconnectWindowSeconds: reconnectWindowMs / 1000,
      iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
      turnConfigured: false
    });
  });

  app.use(express.static(publicDir, {
    etag: true,
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    }
  }));

  app.get('/{*splat}', (_req, res) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  function activeParentCount(session) {
    return [...session.parents.values()].filter((parent) => parent.socketId && !parent.interruptedAt).length;
  }

  function parentByToken(session, token) {
    for (const parent of session.parents.values()) {
      if (safeEqual(token, parent.token)) return parent;
    }
    return null;
  }

  function findByPin(pin) {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (!session.ended && session.pairExpiresAt > now && safeEqual(session.pin, pin)) return session;
    }
    return null;
  }

  function authenticate(socket, payload, requiredRole) {
    if (!payload || typeof payload !== 'object') return null;
    const session = sessions.get(String(payload.sessionId || ''));
    if (!session || session.ended || session.expiresAt <= Date.now()) return null;
    const role = requiredRole || payload.role;
    if (role === 'baby') {
      if (!safeEqual(payload.token, session.babyToken)) return null;
      if (session.babySocketId && session.babySocketId !== socket.id) return null;
      return { session, role, parent: null };
    }
    if (role === 'parent') {
      const parent = parentByToken(session, payload.token);
      if (!parent) return null;
      if (parent.socketId && parent.socketId !== socket.id) return null;
      return { session, role, parent };
    }
    return null;
  }

  function emitToParents(session, event, payload) {
    for (const parent of session.parents.values()) {
      if (parent.socketId && !parent.interruptedAt) io.to(parent.socketId).emit(event, payload);
    }
  }

  function notifyParentCount(session) {
    const payload = { connected: activeParentCount(session), authorized: session.parents.size, maximum: MAX_PARENTS };
    if (session.babySocketId) io.to(session.babySocketId).emit('parent-count', payload);
    emitToParents(session, 'parent-count', payload);
  }

  function emitPeerReady(session, parent) {
    if (!session.babySocketId || !parent?.socketId || parent.interruptedAt) return;
    io.to(session.babySocketId).emit('peer-ready', { role: 'parent', parentId: parent.id });
    io.to(parent.socketId).emit('peer-ready', {
      role: 'baby',
      parentId: parent.id,
      settings: session.settings,
      babyState: session.babyState
    });
  }

  function removeParent(session, parent, reason = 'reconnect-window-expired') {
    if (!session || !parent || !session.parents.has(parent.id)) return;
    if (parent.socketId) io.to(parent.socketId).emit('parent-session-ended', { reason });
    session.parents.delete(parent.id);
    if (session.babySocketId) io.to(session.babySocketId).emit('parent-expired', { parentId: parent.id, reason });
    notifyParentCount(session);
  }

  function terminateSession(session, reason = 'ended') {
    if (!session || session.ended) return;
    session.ended = true;
    const message = { reason };
    if (session.babySocketId) io.to(session.babySocketId).emit('session-ended', message);
    for (const parent of session.parents.values()) {
      if (parent.socketId) io.to(parent.socketId).emit('session-ended', message);
    }
    sessions.delete(session.id);
  }

  function attemptKey(socket, hint) {
    return `${getClientIp(socket)}:${String(hint || '').slice(0, 48)}`;
  }

  function isBlocked(key) {
    const record = pairAttempts.get(key);
    if (!record) return false;
    if (record.blockedUntil > Date.now()) return true;
    if (record.blockedUntil) pairAttempts.delete(key);
    return false;
  }

  function failedAttempt(key) {
    const now = Date.now();
    const record = pairAttempts.get(key) || { count: 0, firstAt: now, blockedUntil: 0 };
    if (now - record.firstAt > BLOCK_MS) {
      record.count = 0;
      record.firstAt = now;
    }
    record.count += 1;
    if (record.count >= MAX_PAIR_ATTEMPTS) record.blockedUntil = now + BLOCK_MS;
    pairAttempts.set(key, record);
  }

  io.on('connection', (socket) => {
    socket.on('create-session', async (_payload, callback = () => {}) => {
      try {
        const id = randomToken(12);
        let pin;
        do pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
        while (findByPin(pin));
        const now = Date.now();
        const session = {
          id,
          pin,
          qrToken: randomToken(24),
          babyToken: randomToken(),
          babySocketId: socket.id,
          babyDisconnectedAt: null,
          parents: new Map(),
          createdAt: now,
          pairExpiresAt: now + PAIRING_TTL_MS,
          expiresAt: now + SESSION_TTL_MS,
          ended: false,
          settings: { ...DEFAULT_SETTINGS },
          babyState: { micEnabled: true, cryAvailable: true }
        };
        sessions.set(id, session);
        socket.data.sessionId = id;
        socket.data.role = 'baby';

        const origin = configuredPublicUrl || socket.handshake.headers.origin || 'https://babymoon.onrender.com';
        const pairUrl = `${origin}/?role=parent&session=${encodeURIComponent(id)}&qr=${encodeURIComponent(session.qrToken)}`;
        const qrDataUrl = await QRCode.toDataURL(pairUrl, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
        callback({
          ok: true,
          sessionId: id,
          pin,
          pairUrl,
          qrDataUrl,
          babyToken: session.babyToken,
          expiresAt: session.pairExpiresAt,
          settings: session.settings,
          maxParents: MAX_PARENTS
        });
      } catch (_error) {
        callback({ ok: false, error: 'Impossibile creare la sessione.' });
      }
    });

    socket.on('pair-session', (payload = {}, callback = () => {}) => {
      const pin = normalizePin(payload.pin);
      const sessionId = String(payload.sessionId || '');
      const key = attemptKey(socket, sessionId || pin || 'unknown');
      if (isBlocked(key)) {
        callback({ ok: false, error: 'Troppi tentativi. Riprova tra 10 minuti.', code: 'RATE_LIMIT' });
        return;
      }

      let session = null;
      if (sessionId) {
        const candidate = sessions.get(sessionId);
        if (candidate && candidate.pairExpiresAt > Date.now() && safeEqual(payload.qrToken, candidate.qrToken)) session = candidate;
      } else if (pin.length === 6) {
        session = findByPin(pin);
      }

      if (!session || session.ended || session.pairExpiresAt <= Date.now()) {
        failedAttempt(key);
        callback({ ok: false, error: 'Codice non valido o scaduto.', code: 'INVALID_PAIRING' });
        return;
      }
      if (session.parents.size >= MAX_PARENTS) {
        callback({ ok: false, error: `Limite di ${MAX_PARENTS} Parent già raggiunto.`, code: 'PARENT_LIMIT' });
        return;
      }

      const parent = {
        id: randomToken(10),
        token: randomToken(),
        socketId: socket.id,
        interruptedAt: null,
        createdAt: Date.now()
      };
      session.parents.set(parent.id, parent);
      socket.data.sessionId = session.id;
      socket.data.role = 'parent';
      socket.data.parentId = parent.id;
      pairAttempts.delete(key);

      callback({
        ok: true,
        sessionId: session.id,
        parentId: parent.id,
        parentToken: parent.token,
        settings: session.settings,
        babyState: session.babyState,
        maxParents: MAX_PARENTS
      });
      notifyParentCount(session);
      emitPeerReady(session, parent);
    });

    socket.on('resume-session', (payload = {}, callback = () => {}) => {
      const session = sessions.get(String(payload.sessionId || ''));
      if (!session || session.ended || session.expiresAt <= Date.now()) {
        callback({ ok: false, error: 'Sessione non più disponibile.' });
        return;
      }
      if (safeEqual(payload.token, session.babyToken)) {
        session.babySocketId = socket.id;
        session.babyDisconnectedAt = null;
        socket.data.sessionId = session.id;
        socket.data.role = 'baby';
        callback({ ok: true, role: 'baby', settings: session.settings, babyState: session.babyState });
        for (const parent of session.parents.values()) emitPeerReady(session, parent);
        notifyParentCount(session);
        return;
      }
      const parent = parentByToken(session, payload.token);
      if (!parent || (parent.interruptedAt && Date.now() - parent.interruptedAt >= reconnectWindowMs)) {
        callback({ ok: false, error: 'Finestra di riconnessione scaduta.' });
        return;
      }
      parent.socketId = socket.id;
      parent.interruptedAt = null;
      socket.data.sessionId = session.id;
      socket.data.role = 'parent';
      socket.data.parentId = parent.id;
      callback({
        ok: true,
        role: 'parent',
        parentId: parent.id,
        settings: session.settings,
        babyState: session.babyState
      });
      notifyParentCount(session);
      emitPeerReady(session, parent);
    });

    socket.on('signal', (payload = {}) => {
      const role = payload.role;
      const auth = authenticate(socket, payload, role);
      if (!auth || !payload.signal || typeof payload.signal !== 'object') return;
      if (role === 'baby') {
        const parent = auth.session.parents.get(String(payload.targetParentId || ''));
        if (!parent?.socketId || parent.interruptedAt) return;
        io.to(parent.socketId).emit('signal', {
          from: 'baby',
          parentId: parent.id,
          negotiationId: String(payload.negotiationId || '').slice(0, 80),
          signal: payload.signal
        });
      } else if (!auth.parent.interruptedAt && auth.session.babySocketId) {
        io.to(auth.session.babySocketId).emit('signal', {
          from: 'parent',
          parentId: auth.parent.id,
          negotiationId: String(payload.negotiationId || '').slice(0, 80),
          signal: payload.signal
        });
      }
    });

    socket.on('interrupt-parent', (payload = {}, callback = () => {}) => {
      const auth = authenticate(socket, payload, 'parent');
      if (!auth) {
        callback({ ok: false, error: 'Sessione non disponibile.' });
        return;
      }
      auth.parent.interruptedAt = Date.now();
      if (auth.session.babySocketId) {
        io.to(auth.session.babySocketId).emit('peer-interrupted', {
          role: 'parent',
          parentId: auth.parent.id,
          graceMs: reconnectWindowMs
        });
      }
      notifyParentCount(auth.session);
      callback({ ok: true, deadline: auth.parent.interruptedAt + reconnectWindowMs });
    });

    socket.on('control', (payload = {}, callback = () => {}) => {
      const auth = authenticate(socket, payload, 'parent');
      if (!auth || auth.parent.interruptedAt || !auth.session.babySocketId) {
        callback({ ok: false, error: 'Baby non connesso.' });
        return;
      }
      if (payload.command !== 'set-baby-mic' || typeof payload.enabled !== 'boolean') {
        callback({ ok: false, error: 'Comando non valido.' });
        return;
      }
      io.to(auth.session.babySocketId).emit('control', { command: payload.command, enabled: payload.enabled, requestedBy: auth.parent.id });
      callback({ ok: true });
    });

    socket.on('baby-state', (payload = {}) => {
      const auth = authenticate(socket, payload, 'baby');
      if (!auth) return;
      auth.session.babyState = {
        micEnabled: payload.micEnabled !== false,
        cryAvailable: payload.cryAvailable !== false
      };
      emitToParents(auth.session, 'baby-state', auth.session.babyState);
    });

    socket.on('update-settings', (payload = {}, callback = () => {}) => {
      const auth = authenticate(socket, payload, 'parent');
      if (!auth || auth.parent.interruptedAt) {
        callback({ ok: false, error: 'Non autorizzato.' });
        return;
      }
      auth.session.settings = sanitizeSettings(payload.settings);
      if (auth.session.babySocketId) io.to(auth.session.babySocketId).emit('settings-updated', auth.session.settings);
      emitToParents(auth.session, 'settings-updated', auth.session.settings);
      callback({ ok: true, settings: auth.session.settings });
    });

    socket.on('alert', (payload = {}) => {
      const auth = authenticate(socket, payload, 'baby');
      if (!auth || !['cry', 'motion'].includes(payload.type)) return;
      emitToParents(auth.session, 'alert', {
        type: payload.type,
        at: Date.now(),
        confidence: Math.min(1, Math.max(0, Number(payload.confidence) || 0))
      });
    });

    socket.on('end-session', (payload = {}, callback = () => {}) => {
      const auth = authenticate(socket, payload, payload.role);
      if (!auth) {
        callback({ ok: false });
        return;
      }
      callback({ ok: true });
      terminateSession(auth.session, `${payload.role || 'peer'}-ended`);
    });

    socket.on('heartbeat', (payload = {}, callback = () => {}) => {
      const auth = authenticate(socket, payload, payload.role);
      callback({ ok: Boolean(auth), at: Date.now() });
    });

    socket.on('disconnect', () => {
      const session = sessions.get(socket.data.sessionId);
      if (!session || session.ended) return;
      if (socket.data.role === 'baby' && session.babySocketId === socket.id) {
        session.babySocketId = null;
        session.babyDisconnectedAt = Date.now();
        emitToParents(session, 'peer-disconnected', { role: 'baby', graceMs: reconnectWindowMs });
      }
      if (socket.data.role === 'parent') {
        const parent = session.parents.get(socket.data.parentId);
        if (parent && parent.socketId === socket.id) {
          parent.socketId = null;
          parent.interruptedAt = Date.now();
          if (session.babySocketId) io.to(session.babySocketId).emit('peer-disconnected', { role: 'parent', parentId: parent.id, graceMs: reconnectWindowMs });
        }
      }
      notifyParentCount(session);
    });
  });

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (session.ended || session.expiresAt <= now || (session.babyDisconnectedAt && now - session.babyDisconnectedAt >= reconnectWindowMs)) {
        terminateSession(session, 'reconnect-window-expired');
        continue;
      }
      for (const parent of [...session.parents.values()]) {
        if (parent.interruptedAt && now - parent.interruptedAt >= reconnectWindowMs) removeParent(session, parent);
      }
    }
    for (const [key, record] of pairAttempts) {
      if (now - record.firstAt > BLOCK_MS * 2) pairAttempts.delete(key);
    }
  }, cleanupMs);
  cleanupTimer.unref();

  function close() {
    clearInterval(cleanupTimer);
    return new Promise((resolve) => io.close(() => {
      if (httpServer.listening) httpServer.close(() => resolve());
      else resolve();
    }));
  }

  return { app, io, httpServer, sessions, close, constants: { MAX_PARENTS, RECONNECT_WINDOW_MS: reconnectWindowMs } };
}

if (require.main === module) {
  const { httpServer } = createAppServer();
  const port = Number(process.env.PORT) || 3000;
  httpServer.listen(port, '0.0.0.0', () => console.log(`BabyMoon v${VERSION} http://localhost:${port}`));
}

module.exports = { createAppServer, sanitizeSettings, normalizePin };
