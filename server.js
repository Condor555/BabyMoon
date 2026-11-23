'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const PAIRING_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DISCONNECTED_SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const ROLES = new Set(['baby', 'parent']);
const SIGNAL_TYPES = new Set(['offer', 'answer', 'ice-candidate', 'end-of-candidates']);

function token(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function normalizePin(value) {
  return String(value ?? '').replace(/\D/g, '').slice(0, 6);
}

function safeOrigin(socket, configuredOrigin) {
  if (configuredOrigin) return configuredOrigin.replace(/\/$/, '');
  const forwardedProto = String(socket.handshake.headers['x-forwarded-proto'] || '').split(',')[0];
  const protocol = forwardedProto || (socket.handshake.secure ? 'https' : 'http');
  const host = socket.handshake.headers['x-forwarded-host'] || socket.handshake.headers.host;
  return `${protocol}://${host}`;
}

function parseIceServers(env = process.env) {
  const iceServers = [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
  ];

  const urls = String(env.TURN_URLS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (urls.length && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    iceServers.push({
      urls,
      username: String(env.TURN_USERNAME),
      credential: String(env.TURN_CREDENTIAL)
    });
  }

  return iceServers;
}

function createBabyMoonServer(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    transports: ['websocket', 'polling'],
    pingInterval: 20_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 128 * 1024,
    cors: false
  });

  const sessions = new Map();
  const attempts = new Map();
  const publicDir = path.join(__dirname, 'public');
  const publicUrl = String(env.PUBLIC_URL || '').trim();
  const iceServers = parseIceServers(env);
  const turnConfigured = iceServers.some((entry) => {
    const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
    return urls.some((url) => String(url).startsWith('turn:') || String(url).startsWith('turns:'));
  });

  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    if (env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] === 'http') {
      return res.redirect(308, `https://${req.headers.host}${req.originalUrl}`);
    }
    return next();
  });
  app.use(helmet({
    crossOriginEmbedderPolicy: false,
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
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"]
      }
    },
    referrerPolicy: { policy: 'no-referrer' }
  }));
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, name: 'BabyMoon', version: '1.0.3' });
  });

  app.get('/api/ice-config', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      iceServers,
      turnConfigured,
      iceTransportPolicy: 'all'
    });
  });

  app.use(express.static(publicDir, {
    etag: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith('sw.js') || filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
    }
  }));
  // Express 5 requires a named wildcard.
  app.get('/*splat', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  function publicSession(session) {
    return {
      sessionId: session.id,
      role: undefined,
      expiresAt: session.expiresAt,
      turnConfigured
    };
  }

  function getPeerSocket(session, role) {
    const id = role === 'baby' ? session.parentSocketId : session.babySocketId;
    return id ? io.sockets.sockets.get(id) : null;
  }

  function emitPresence(session) {
    const payload = {
      baby: Boolean(session.babySocketId && io.sockets.sockets.has(session.babySocketId)),
      parent: Boolean(session.parentSocketId && io.sockets.sockets.has(session.parentSocketId)),
      paired: session.paired
    };
    io.to(session.id).emit('presence', payload);
    if (payload.baby && payload.parent) {
      io.to(session.babySocketId).emit('peer-ready', { role: 'parent' });
      io.to(session.parentSocketId).emit('peer-ready', { role: 'baby' });
    }
  }

  function leaveCurrentSession(socket) {
    const { sessionId, role } = socket.data;
    if (!sessionId || !ROLES.has(role)) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    if (role === 'baby' && session.babySocketId === socket.id) session.babySocketId = null;
    if (role === 'parent' && session.parentSocketId === socket.id) session.parentSocketId = null;
    socket.leave(sessionId);
    socket.data.sessionId = null;
    socket.data.role = null;
    session.lastDisconnectedAt = Date.now();
    const peer = getPeerSocket(session, role);
    peer?.emit('peer-disconnected', { role });
    emitPresence(session);
  }

  function authorizeSocket(socket) {
    const { sessionId, role } = socket.data;
    if (!sessionId || !ROLES.has(role)) return null;
    const session = sessions.get(sessionId);
    if (!session || session.ended) return null;
    const expected = role === 'baby' ? session.babySocketId : session.parentSocketId;
    return expected === socket.id ? session : null;
  }

  function bindSocketToSession(socket, session, role) {
    leaveCurrentSession(socket);
    const key = role === 'baby' ? 'babySocketId' : 'parentSocketId';
    const previousId = session[key];
    if (previousId && previousId !== socket.id) {
      const previousSocket = io.sockets.sockets.get(previousId);
      previousSocket?.emit('session-replaced');
      previousSocket?.leave(session.id);
    }
    session[key] = socket.id;
    session.lastSeenAt = Date.now();
    socket.data.sessionId = session.id;
    socket.data.role = role;
    socket.join(session.id);
  }

  function attemptKey(socket, sessionId) {
    return `${socket.handshake.address}|${sessionId || 'unknown'}`;
  }

  function isRateLimited(socket, sessionId) {
    const key = attemptKey(socket, sessionId);
    const now = Date.now();
    const recent = (attempts.get(key) || []).filter((value) => now - value < ATTEMPT_WINDOW_MS);
    attempts.set(key, recent);
    return recent.length >= MAX_PAIRING_ATTEMPTS;
  }

  function recordFailedAttempt(socket, sessionId) {
    const key = attemptKey(socket, sessionId);
    const recent = attempts.get(key) || [];
    recent.push(Date.now());
    attempts.set(key, recent);
  }

  function clearAttempts(socket, sessionId) {
    attempts.delete(attemptKey(socket, sessionId));
  }

  function findSessionByPin(pin) {
    for (const session of sessions.values()) {
      if (!session.ended && !session.paired && session.pin === pin) return session;
    }
    return null;
  }

  function endSession(session, reason = 'ended') {
    if (!session || session.ended) return;
    session.ended = true;
    session.pin = null;
    session.pairingToken = null;
    io.to(session.id).emit('session-ended', { reason });
    for (const socketId of [session.babySocketId, session.parentSocketId]) {
      const member = socketId ? io.sockets.sockets.get(socketId) : null;
      if (member) {
        member.data.sessionId = null;
        member.data.role = null;
        member.leave(session.id);
      }
    }
    sessions.delete(session.id);
  }

  io.on('connection', (socket) => {
    socket.data.sessionId = null;
    socket.data.role = null;

    socket.on('create-session', async (_payload, ack = () => {}) => {
      try {
        const session = {
          id: token(16),
          pin: String(crypto.randomInt(100000, 1_000_000)),
          pairingToken: token(32),
          babyToken: token(32),
          parentToken: token(32),
          babySocketId: null,
          parentSocketId: null,
          paired: false,
          ended: false,
          createdAt: Date.now(),
          expiresAt: Date.now() + SESSION_TTL_MS,
          pairingExpiresAt: Date.now() + PAIRING_TTL_MS,
          lastSeenAt: Date.now(),
          lastDisconnectedAt: null
        };
        sessions.set(session.id, session);
        bindSocketToSession(socket, session, 'baby');
        const origin = safeOrigin(socket, publicUrl);
        const joinUrl = `${origin}/?join=${encodeURIComponent(session.id)}&token=${encodeURIComponent(session.pairingToken)}`;
        const qrDataUrl = await QRCode.toDataURL(joinUrl, {
          errorCorrectionLevel: 'M',
          margin: 1,
          width: 512,
          color: { dark: '#07111f', light: '#ffffff' }
        });
        ack({
          ok: true,
          ...publicSession(session),
          role: 'baby',
          pin: session.pin,
          resumeToken: session.babyToken,
          joinUrl,
          qrDataUrl
        });
        emitPresence(session);
      } catch (error) {
        logger.error('create-session failed', error);
        ack({ ok: false, error: 'Impossibile creare la sessione.' });
      }
    });

    socket.on('join-session', (payload = {}, ack = () => {}) => {
      const requestedId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
      const pin = normalizePin(payload.pin);
      const session = requestedId ? sessions.get(requestedId) : findSessionByPin(pin);
      const rateLimitId = requestedId || pin;

      if (isRateLimited(socket, rateLimitId)) {
        return ack({ ok: false, error: 'Troppi tentativi. Riprova tra 10 minuti.' });
      }
      if (!session || session.ended) {
        recordFailedAttempt(socket, rateLimitId);
        return ack({ ok: false, error: 'Sessione non trovata.' });
      }
      if (Date.now() > session.pairingExpiresAt) {
        recordFailedAttempt(socket, session.id);
        return ack({ ok: false, error: 'Codice scaduto. Crea una nuova sessione.' });
      }
      if (session.paired) {
        recordFailedAttempt(socket, session.id);
        return ack({ ok: false, error: 'Questa sessione ha già un Parent.' });
      }

      const suppliedPairingToken = typeof payload.pairingToken === 'string'
        ? Buffer.from(payload.pairingToken)
        : Buffer.alloc(0);
      const expectedPairingToken = Buffer.from(session.pairingToken || '');
      const validQr = Boolean(requestedId) && suppliedPairingToken.length === expectedPairingToken.length &&
        suppliedPairingToken.length > 0 && crypto.timingSafeEqual(suppliedPairingToken, expectedPairingToken);
      const validPin = pin.length === 6 && pin === session.pin;
      if (!validQr && !validPin) {
        recordFailedAttempt(socket, session.id);
        return ack({ ok: false, error: 'Codice non valido.' });
      }

      clearAttempts(socket, session.id);
      session.paired = true;
      session.pin = null;
      session.pairingToken = null;
      bindSocketToSession(socket, session, 'parent');
      ack({
        ok: true,
        ...publicSession(session),
        role: 'parent',
        resumeToken: session.parentToken
      });
      emitPresence(session);
    });

    socket.on('resume-session', (payload = {}, ack = () => {}) => {
      const session = typeof payload.sessionId === 'string' ? sessions.get(payload.sessionId) : null;
      const role = payload.role;
      if (!session || session.ended || !ROLES.has(role) || typeof payload.resumeToken !== 'string') {
        return ack({ ok: false, error: 'Sessione non disponibile.' });
      }
      const expectedToken = role === 'baby' ? session.babyToken : session.parentToken;
      const supplied = Buffer.from(payload.resumeToken);
      const expected = Buffer.from(expectedToken);
      if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
        return ack({ ok: false, error: 'Token di sessione non valido.' });
      }
      if (Date.now() > session.expiresAt) {
        endSession(session, 'expired');
        return ack({ ok: false, error: 'Sessione scaduta.' });
      }
      bindSocketToSession(socket, session, role);
      ack({ ok: true, ...publicSession(session), role });
      emitPresence(session);
    });

    socket.on('signal', (payload = {}, ack = () => {}) => {
      const session = authorizeSocket(socket);
      if (!session) return ack({ ok: false, error: 'Non autorizzato.' });
      const { type, negotiationId } = payload;
      if (!SIGNAL_TYPES.has(type) || typeof negotiationId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(negotiationId)) {
        return ack({ ok: false, error: 'Segnale non valido.' });
      }
      if ((type === 'offer' || type === 'answer') && (!payload.sdp || typeof payload.sdp.sdp !== 'string')) {
        return ack({ ok: false, error: 'SDP non valido.' });
      }
      if (type === 'ice-candidate' && (!payload.candidate || typeof payload.candidate.candidate !== 'string')) {
        return ack({ ok: false, error: 'Candidato ICE non valido.' });
      }
      const peer = getPeerSocket(session, socket.data.role);
      if (!peer) return ack({ ok: false, error: 'Peer non collegato.' });
      peer.emit('signal', {
        type,
        negotiationId,
        sdp: payload.sdp,
        candidate: payload.candidate,
        from: socket.data.role
      });
      ack({ ok: true });
    });

    socket.on('end-session', (_payload, ack = () => {}) => {
      const session = authorizeSocket(socket);
      if (!session) return ack({ ok: false, error: 'Sessione non disponibile.' });
      endSession(session, `ended-by-${socket.data.role}`);
      ack({ ok: true });
    });

    socket.on('disconnect', () => leaveCurrentSession(socket));
  });

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      const bothOffline = !session.babySocketId && !session.parentSocketId;
      const offlineExpired = bothOffline && session.lastDisconnectedAt &&
        now - session.lastDisconnectedAt > DISCONNECTED_SESSION_TTL_MS;
      if (now > session.expiresAt || offlineExpired) endSession(session, 'expired');
    }
    for (const [key, values] of attempts) {
      const recent = values.filter((value) => now - value < ATTEMPT_WINDOW_MS);
      if (recent.length) attempts.set(key, recent);
      else attempts.delete(key);
    }
  }, 30_000);
  cleanupTimer.unref();

  async function close() {
    clearInterval(cleanupTimer);
    io.close();
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }

  return { app, server, io, sessions, close, iceServers, turnConfigured };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const instance = createBabyMoonServer();
  instance.server.listen(port, '0.0.0.0', () => {
    console.log(`BabyMoon 1.0.3 listening on http://0.0.0.0:${port}`);
  });
}

module.exports = { createBabyMoonServer, parseIceServers };
