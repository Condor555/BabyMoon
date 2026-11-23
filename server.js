import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import express from 'express';
import helmet from 'helmet';
import QRCode from 'qrcode';
import { Server } from 'socket.io';

const dir = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  serveClient: true,
});

const sessions = new Map();
const failedJoinsByKey = new Map();
const PORT = Number(process.env.PORT) || 3000;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const ACTIVE_TTL_MS = 12 * 60 * 60 * 1000;
const FAILED_JOIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILED_JOINS = 5;
const MAX_SESSION_CREATES_PER_WINDOW = 10;

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && !req.secure) {
    const host = req.get('host');
    if (!host) return res.status(400).end();
    return res.redirect(308, `https://${host}${req.originalUrl}`);
  }
  next();
});
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        fontSrc: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:'],
        manifestSrc: ["'self'"],
        mediaSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        workerSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
  }),
);
app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  next();
});
app.use(compression());
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(dir, 'public')));

function publicBaseUrl(req) {
  const configured = process.env.PUBLIC_URL?.trim().replace(/\/+$/, '');
  const candidate = configured || `${req.protocol}://${req.get('host')}`;
  const parsed = new URL(candidate);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('PUBLIC_URL non valida.');
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new Error('PUBLIC_URL deve usare HTTPS in produzione.');
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, '');
}

function getSessionForSocket(socket) {
  const { sessionCode, role } = socket.data;
  const session = sessions.get(sessionCode);
  if (!session || !['baby', 'parent'].includes(role) || session[role] !== socket.id) return null;
  return { code: sessionCode, role, session };
}

function touchSession(session) {
  session.expiresAt = Date.now() + (session.paired ? ACTIVE_TTL_MS : PAIRING_TTL_MS);
}

function configuredIceServers() {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  const urls = process.env.TURN_URLS?.split(',').map((value) => value.trim()).filter(Boolean);
  const username = process.env.TURN_USERNAME?.trim();
  const credential = process.env.TURN_CREDENTIAL?.trim();
  if (urls?.length && username && credential) servers.push({ urls, username, credential });
  return servers;
}

function hasTurnServer(servers) {
  return servers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((url) => /^turns?:/i.test(String(url || '')));
  });
}

function emitPresence(code, session) {
  io.to(code).emit('presence', { baby: Boolean(session.baby), parent: Boolean(session.parent) });
}

function clearSocketMembership(socket) {
  socket.data.sessionCode = null;
  socket.data.role = null;
}

function detachSocket(socket, notifyPeer = true) {
  const current = getSessionForSocket(socket);
  if (!current) {
    clearSocketMembership(socket);
    return;
  }

  const { code, role, session } = current;
  session[role] = null;
  touchSession(session);
  socket.leave(code);
  clearSocketMembership(socket);

  if (notifyPeer) io.to(code).emit('peer-disconnected', { role });
  emitPresence(code, session);
}

function endSession(code, endedBy, reason = 'user') {
  const session = sessions.get(code);
  if (!session) return false;

  sessions.delete(code);
  io.to(code).emit('session-ended', { endedBy, reason });

  for (const socketId of [session.baby, session.parent]) {
    if (!socketId) continue;
    const participant = io.sockets.sockets.get(socketId);
    if (!participant) continue;
    participant.leave(code);
    clearSocketMembership(participant);
  }
  return true;
}

function failureBucket(key) {
  const now = Date.now();
  const current = failedJoinsByKey.get(key);
  if (!current || current.resetAt <= now) {
    const fresh = { count: 0, resetAt: now + FAILED_JOIN_WINDOW_MS };
    failedJoinsByKey.set(key, fresh);
    return fresh;
  }
  return current;
}

function pairingKeys(ip, code) {
  return [`ip:${ip}`, `session:${code}`];
}

function registerFailedJoin(ip, code) {
  for (const key of pairingKeys(ip, code)) failureBucket(key).count += 1;
}

function joinIsRateLimited(ip, code) {
  return pairingKeys(ip, code).some((key) => failureBucket(key).count >= MAX_FAILED_JOINS);
}

function validSignal(payload, role) {
  if (!payload || typeof payload !== 'object') return false;
  if (!/^[A-Za-z0-9-]{16,64}$/.test(String(payload.negotiationId || ''))) return false;
  if (payload.description) {
    const { type, sdp } = payload.description;
    const expectedType = role === 'baby' ? 'offer' : 'answer';
    return type === expectedType && typeof sdp === 'string' && sdp.length <= 1e6;
  }
  if (payload.candidate) {
    return typeof payload.candidate.candidate === 'string' && payload.candidate.candidate.length <= 16_384;
  }
  return false;
}

function safeTokenEqual(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post('/api/session', async (req, res) => {
  const createBucket = failureBucket(`create:${req.ip || 'unknown'}`);
  if (createBucket.count >= MAX_SESSION_CREATES_PER_WINDOW) {
    res.setHeader('Retry-After', Math.ceil((createBucket.resetAt - Date.now()) / 1_000));
    return res.status(429).json({ error: 'Troppe sessioni create. Riprova più tardi.' });
  }
  createBucket.count += 1;

  let code;
  do code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  while (sessions.has(code));

  const token = crypto.randomBytes(32).toString('hex');
  const qrToken = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + PAIRING_TTL_MS;
  sessions.set(code, {
    babyToken: token,
    parentToken: null,
    qrToken,
    paired: false,
    baby: null,
    parent: null,
    expiresAt,
  });

  const url = `${publicBaseUrl(req)}/?mode=parent&code=${code}&pair=${encodeURIComponent(qrToken)}`;
  const qr = await QRCode.toDataURL(url, { width: 420, margin: 1 });
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json({ code, token, qr, pairingUrl: url, expiresAt });
});

app.get('/api/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, service: 'BabyMoon', version: '1.0.2' });
});

app.get('/api/config', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const iceServers = configuredIceServers();
  res.json({ iceServers, hasTurn: hasTurnServer(iceServers) });
});

app.post('/api/session/:code/end', (req, res) => {
  const code = String(req.params.code || '').slice(0, 6);
  const role = req.body?.role;
  const token = req.body?.token;
  const session = sessions.get(code);
  if (!/^\d{6}$/.test(code) || !session || !['baby', 'parent'].includes(role)) {
    return res.status(404).json({ ok: false });
  }
  const expected = role === 'baby' ? session.babyToken : session.parentToken;
  if (!safeTokenEqual(token, expected)) return res.status(403).json({ ok: false });

  endSession(code, role, 'user');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true });
});

// Express 5 requires a named wildcard. Static files and the SPA root are served above.
app.get('/*splat', (_req, res) => res.sendFile(path.join(dir, 'public/index.html')));

io.on('connection', (socket) => {
  socket.data.sessionCode = null;
  socket.data.role = null;

  socket.on('join', (request = {}, ack = () => {}) => {
    const code = String(request.code || '').slice(0, 12);
    const role = request.role;
    const token = typeof request.token === 'string' && request.token.length <= 128 ? request.token : null;
    const source = typeof request.source === 'string' && request.source.length <= 8 ? request.source : null;
    const pairingToken = typeof request.pairingToken === 'string' && request.pairingToken.length <= 128 ? request.pairingToken : null;
    const ip = socket.handshake.address || 'unknown';

    if (joinIsRateLimited(ip, code)) {
      return ack({ ok: false, error: 'Troppi tentativi. Riprova tra qualche minuto.' });
    }

    const session = sessions.get(code);
    const fail = (error) => {
      registerFailedJoin(ip, code);
      ack({ ok: false, error });
    };

    if (!/^\d{6}$/.test(code) || !['baby', 'parent'].includes(role)) {
      return fail('Richiesta di collegamento non valida.');
    }
    if (!session || session.expiresAt <= Date.now()) {
      if (session) endSession(code, 'system', 'expired');
      return fail('Sessione non valida o scaduta.');
    }
    if (role === 'baby' && token !== session.babyToken) return fail('Token non valido.');
    if (role === 'parent' && session.paired && token !== session.parentToken) {
      return fail('Questa sessione è già associata a un altro Parent.');
    }
    if (role === 'parent' && !session.paired) {
      if (source === 'qr' && !safeTokenEqual(pairingToken, session.qrToken)) {
        return fail('QR non valido o scaduto.');
      }
      if (source !== 'qr' && source !== 'pin') return fail('Metodo di pairing non valido.');
    }

    const occupiedBy = session[role];
    if (occupiedBy && occupiedBy !== socket.id && io.sockets.sockets.has(occupiedBy)) {
      return fail(role === 'parent' ? 'Un genitore è già collegato.' : 'Il dispositivo Baby è già collegato.');
    }

    detachSocket(socket, false);
    socket.data.sessionCode = code;
    socket.data.role = role;
    socket.join(code);
    session[role] = socket.id;
    let participantToken;
    if (role === 'parent' && !session.paired) {
      session.parentToken = crypto.randomBytes(32).toString('hex');
      session.paired = true;
      session.qrToken = null;
      participantToken = session.parentToken;
      failedJoinsByKey.delete(`session:${code}`);
    }
    touchSession(session);

    ack({
      ok: true,
      peerOnline: Boolean(session[role === 'baby' ? 'parent' : 'baby']),
      participantToken,
    });
    emitPresence(code, session);
    if (session.baby && session.parent) io.to(session.baby).emit('parent-ready');
  });

  socket.on('signal', (payload, ack = () => {}) => {
    const current = getSessionForSocket(socket);
    if (!current) return ack({ ok: false, error: 'Sessione non attiva.' });
    if (!validSignal(payload, current.role)) return ack({ ok: false, error: 'Segnale WebRTC non valido.' });

    const targetRole = current.role === 'baby' ? 'parent' : 'baby';
    const targetId = current.session[targetRole];
    if (!targetId) return ack({ ok: false, error: 'L’altro dispositivo non è collegato.' });

    touchSession(current.session);
    io.to(targetId).emit('signal', { payload });
    ack({ ok: true });
  });

  socket.on('end-session', (ack = () => {}) => {
    const current = getSessionForSocket(socket);
    if (!current) return ack({ ok: false, error: 'Sessione non attiva.' });

    const ended = endSession(current.code, current.role, 'user');
    ack({ ok: ended });
  });

  socket.on('request-reconnect', (ack = () => {}) => {
    const current = getSessionForSocket(socket);
    if (!current) return ack({ ok: false, error: 'Sessione non attiva.' });
    if (current.role !== 'parent') return ack({ ok: false, error: 'Ruolo non autorizzato.' });
    if (!current.session.baby) return ack({ ok: false, error: 'Il dispositivo Baby non è online.' });

    touchSession(current.session);
    io.to(current.session.baby).emit('retry-request');
    ack({ ok: true });
  });

  socket.on('disconnect', () => detachSocket(socket, true));
});

setInterval(() => {
  const now = Date.now();
  for (const [code, session] of sessions) {
    if (session.expiresAt <= now) endSession(code, 'system', 'expired');
  }
  for (const [key, bucket] of failedJoinsByKey) {
    if (bucket.resetAt <= now) failedJoinsByKey.delete(key);
  }
}, 60_000).unref();

app.use((error, _req, res, _next) => {
  console.error(error);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Errore interno del server.' });
});

server.listen(PORT, () => console.log(`BabyMoon v1.0.2 http://localhost:${PORT}`));
