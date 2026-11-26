'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT || 3000);
const VERSION = '1.2.0';
const MAX_PARENTS = 3;
const INVITE_TTL_MS = 5 * 60 * 1000;
const RECONNECT_TTL_MS = 30 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
const safeEqual = (left = '', right = '') => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const normalizePin = (pin = '') => String(pin).replace(/\D/g, '').slice(0, 6);
const publicOrigin = (socket) => {
  const configured = String(process.env.PUBLIC_URL || '').replace(/\/$/, '');
  if (configured) return configured;
  const forwarded = socket.handshake.headers['x-forwarded-proto'];
  const protocol = forwarded || (socket.handshake.secure ? 'https' : 'http');
  return `${protocol}://${socket.handshake.headers.host}`;
};

class SlidingWindowLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  take(key, now = Date.now()) {
    const recent = (this.hits.get(key) || []).filter((time) => now - time < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  clearExpired(now = Date.now()) {
    for (const [key, hits] of this.hits) {
      const recent = hits.filter((time) => now - time < this.windowMs);
      if (recent.length) this.hits.set(key, recent);
      else this.hits.delete(key);
    }
  }
}

class SessionRegistry {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.sessions = new Map();
    this.invitesById = new Map();
    this.invitesByPin = new Map();
  }

  createSession(babySocketId) {
    const id = crypto.randomUUID();
    const session = {
      id,
      babySocketId,
      babyToken: randomToken(),
      createdAt: this.now(),
      expiresAt: this.now() + SESSION_TTL_MS,
      parents: new Map(),
      activeInviteIds: new Set(),
      micEnabled: true,
      detection: { cry: true, motion: true, sensitivity: 'medium', cooldown: 20 },
      environment: { luminance: null, lowLight: false },
      ended: false
    };
    this.sessions.set(id, session);
    return session;
  }

  getSession(id) {
    const session = this.sessions.get(id);
    if (!session || session.ended || session.expiresAt <= this.now()) return null;
    return session;
  }

  parentCount(session) {
    return [...session.parents.values()].filter((parent) => parent.reconnectUntil > this.now() || parent.socketId).length;
  }

  slots(session) {
    return Math.max(0, MAX_PARENTS - this.parentCount(session));
  }

  authenticateBaby(session, token, socketId) {
    return Boolean(session && session.babySocketId === socketId && safeEqual(session.babyToken, token));
  }

  authenticateParent(session, parentId, token, socketId) {
    const parent = session?.parents.get(parentId);
    return Boolean(parent && parent.socketId === socketId && safeEqual(parent.token, token));
  }

  createInvite(session, creator) {
    if (this.slots(session) <= 0) throw new Error('PARENT_LIMIT');
    const id = crypto.randomUUID();
    let pin;
    do pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    while (this.invitesByPin.has(pin));

    const invite = {
      id,
      secret: randomToken(18),
      pin,
      sessionId: session.id,
      createdAt: this.now(),
      expiresAt: this.now() + INVITE_TTL_MS,
      createdByRole: creator.role,
      createdById: creator.id,
      consumedAt: null,
      revokedAt: null
    };
    this.invitesById.set(id, invite);
    this.invitesByPin.set(pin, id);
    session.activeInviteIds.add(id);
    return invite;
  }

  consumeInvite({ pin, inviteKey }) {
    let invite;
    if (inviteKey) {
      const [id, secret] = String(inviteKey).split('.');
      invite = this.invitesById.get(id);
      if (!invite || !safeEqual(invite.secret, secret)) throw new Error('INVALID_INVITE');
    } else {
      const id = this.invitesByPin.get(normalizePin(pin));
      invite = id ? this.invitesById.get(id) : null;
    }
    if (!invite) throw new Error('INVALID_INVITE');
    if (invite.revokedAt) throw new Error('REVOKED_INVITE');
    if (invite.consumedAt) throw new Error('CONSUMED_INVITE');
    if (invite.expiresAt <= this.now()) throw new Error('EXPIRED_INVITE');

    const session = this.getSession(invite.sessionId);
    if (!session) throw new Error('SESSION_ENDED');
    if (this.slots(session) <= 0) throw new Error('PARENT_LIMIT');

    invite.consumedAt = this.now();
    session.activeInviteIds.delete(invite.id);
    this.invitesByPin.delete(invite.pin);
    return { invite, session };
  }

  revokeInvite(session, inviteId) {
    const invite = this.invitesById.get(inviteId);
    if (!invite || invite.sessionId !== session.id || invite.consumedAt || invite.revokedAt) return false;
    invite.revokedAt = this.now();
    session.activeInviteIds.delete(invite.id);
    this.invitesByPin.delete(invite.pin);
    return true;
  }

  addParent(session, socketId) {
    if (this.slots(session) <= 0) throw new Error('PARENT_LIMIT');
    const parent = {
      id: crypto.randomUUID(),
      token: randomToken(),
      socketId,
      joinedAt: this.now(),
      reconnectUntil: this.now() + RECONNECT_TTL_MS,
      listening: true,
      adaptiveVolume: true
    };
    session.parents.set(parent.id, parent);
    return parent;
  }

  reconnect(session, parentId, token, socketId) {
    const parent = session?.parents.get(parentId);
    if (!parent || !safeEqual(parent.token, token) || parent.reconnectUntil <= this.now()) return null;
    parent.socketId = socketId;
    parent.reconnectUntil = this.now() + RECONNECT_TTL_MS;
    return parent;
  }

  disconnectParent(session, parentId) {
    const parent = session?.parents.get(parentId);
    if (!parent) return;
    parent.socketId = null;
    parent.reconnectUntil = this.now() + RECONNECT_TTL_MS;
  }

  removeExpired() {
    const now = this.now();
    const changedSessions = new Set();
    for (const invite of this.invitesById.values()) {
      if (invite.expiresAt <= now && !invite.consumedAt && !invite.revokedAt) {
        this.invitesByPin.delete(invite.pin);
        this.sessions.get(invite.sessionId)?.activeInviteIds.delete(invite.id);
      }
    }
    for (const [id, session] of this.sessions) {
      for (const [parentId, parent] of session.parents) {
        if (!parent.socketId && parent.reconnectUntil <= now) {
          session.parents.delete(parentId);
          changedSessions.add(session.id);
        }
      }
      if (session.ended || session.expiresAt <= now) this.sessions.delete(id);
    }
    return changedSessions;
  }
}

function createApplication() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    transports: ['websocket', 'polling'],
    pingTimeout: 20_000,
    maxHttpBufferSize: 150_000
  });
  const registry = new SessionRegistry();
  const sessionLimiter = new SlidingWindowLimiter(5, 60_000);
  const inviteLimiter = new SlidingWindowLimiter(4, 60_000);
  const joinLimiter = new SlidingWindowLimiter(12, 60_000);

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), fullscreen=(self), display-capture=()');
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });
  app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'BabyMoon', version: VERSION }));
  app.get('/api/qr', async (req, res) => {
    const data = String(req.query.data || '');
    if (!data || data.length > 1000) return res.status(400).end();
    try {
      const png = await QRCode.toBuffer(data, { type: 'png', width: 560, margin: 2, errorCorrectionLevel: 'M' });
      res.type('png').set('Cache-Control', 'no-store').send(png);
    } catch {
      res.status(400).end();
    }
  });
  app.get('/vendor/jsQR.js', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(path.join(__dirname, 'node_modules/jsqr/dist/jsQR.js'));
  });
  app.use(express.static(path.join(__dirname, 'public'), {
    etag: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  }));
  app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

  const ackError = (ack, code) => typeof ack === 'function' && ack({ ok: false, code });
  const statusPayload = (session) => ({
    connected: registry.parentCount(session),
    max: MAX_PARENTS,
    available: registry.slots(session),
    micEnabled: session.micEnabled
  });
  const broadcastStatus = (session) => io.to(`session:${session.id}`).emit('session-status', statusPayload(session));
  const invitePayload = (invite, socket) => {
    const inviteKey = `${invite.id}.${invite.secret}`;
    const joinUrl = `${publicOrigin(socket)}/?mode=parent&invite=${encodeURIComponent(inviteKey)}`;
    return {
      inviteId: invite.id,
      pin: invite.pin,
      joinUrl,
      expiresAt: invite.expiresAt,
      qrUrl: `/api/qr?data=${encodeURIComponent(joinUrl)}`
    };
  };

  io.on('connection', (socket) => {
    const forwardedFor = String(socket.handshake.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ipKey = forwardedFor || socket.handshake.address || 'unknown';

    socket.on('create-session', (_payload, ack) => {
      if (!sessionLimiter.take(`session:${ipKey}`)) return ackError(ack, 'RATE_LIMIT');
      const session = registry.createSession(socket.id);
      socket.data = { role: 'baby', sessionId: session.id };
      socket.join(`session:${session.id}`);
      const invite = registry.createInvite(session, { role: 'baby', id: socket.id });
      ack?.({
        ok: true,
        sessionId: session.id,
        babyToken: session.babyToken,
        invite: invitePayload(invite, socket),
        status: statusPayload(session),
        detection: session.detection
      });
    });

    socket.on('create-pairing', (payload = {}, ack) => {
      const session = registry.getSession(payload.sessionId);
      const isBaby = registry.authenticateBaby(session, payload.token, socket.id);
      const isParent = registry.authenticateParent(session, payload.parentId, payload.token, socket.id);
      if (!isBaby && !isParent) return ackError(ack, 'UNAUTHORIZED');
      const creatorKey = isBaby ? 'baby' : `parent:${payload.parentId}`;
      if (!inviteLimiter.take(`${session.id}:${creatorKey}`)) return ackError(ack, 'RATE_LIMIT');
      try {
        const invite = registry.createInvite(session, {
          role: isBaby ? 'baby' : 'parent',
          id: isBaby ? socket.id : payload.parentId
        });
        ack?.({ ok: true, invite: invitePayload(invite, socket), status: statusPayload(session) });
      } catch (error) {
        ackError(ack, error.message);
      }
    });

    socket.on('revoke-pairing', (payload = {}, ack) => {
      const session = registry.getSession(payload.sessionId);
      const authorized = registry.authenticateBaby(session, payload.token, socket.id)
        || registry.authenticateParent(session, payload.parentId, payload.token, socket.id);
      if (!authorized) return ackError(ack, 'UNAUTHORIZED');
      const revoked = registry.revokeInvite(session, payload.inviteId);
      ack?.({ ok: revoked });
    });

    socket.on('join-session', (payload = {}, ack) => {
      if (!joinLimiter.take(`join:${ipKey}`)) return ackError(ack, 'RATE_LIMIT');
      try {
        const { session, invite } = registry.consumeInvite({ pin: payload.pin, inviteKey: payload.invite });
        const parent = registry.addParent(session, socket.id);
        socket.data = { role: 'parent', sessionId: session.id, parentId: parent.id };
        socket.join(`session:${session.id}`);
        ack?.({
          ok: true,
          sessionId: session.id,
          parentId: parent.id,
          parentToken: parent.token,
          reconnectUntil: parent.reconnectUntil,
          status: statusPayload(session),
          detection: session.detection,
          environment: session.environment
        });
        io.to(`session:${session.id}`).emit('pairing-consumed', { inviteId: invite.id });
        io.to(session.babySocketId).emit('parent-connected', { parentId: parent.id });
        broadcastStatus(session);
      } catch (error) {
        ackError(ack, error.message);
      }
    });

    socket.on('reconnect-session', (payload = {}, ack) => {
      const session = registry.getSession(payload.sessionId);
      const parent = registry.reconnect(session, payload.parentId, payload.parentToken, socket.id);
      if (!parent) return ackError(ack, 'RECONNECT_EXPIRED');
      socket.data = { role: 'parent', sessionId: session.id, parentId: parent.id };
      socket.join(`session:${session.id}`);
      ack?.({ ok: true, reconnectUntil: parent.reconnectUntil, status: statusPayload(session), detection: session.detection, environment: session.environment });
      io.to(session.babySocketId).emit('parent-connected', { parentId: parent.id, reconnected: true });
      broadcastStatus(session);
    });

    socket.on('parent-pause', (payload = {}, ack) => {
      const session = registry.getSession(payload.sessionId);
      if (!registry.authenticateParent(session, payload.parentId, payload.parentToken, socket.id)) return ackError(ack, 'UNAUTHORIZED');
      const parent = session.parents.get(payload.parentId);
      parent.reconnectUntil = Date.now() + RECONNECT_TTL_MS;
      io.to(session.babySocketId).emit('parent-paused', { parentId: parent.id });
      ack?.({ ok: true, reconnectUntil: parent.reconnectUntil });
    });

    socket.on('webrtc-signal', (payload = {}) => {
      const session = registry.getSession(socket.data?.sessionId);
      if (!session || payload.sessionId !== session.id) return;
      if (socket.data.role === 'baby' && registry.authenticateBaby(session, payload.token, socket.id)) {
        const parent = session.parents.get(payload.parentId);
        if (parent?.socketId) io.to(parent.socketId).emit('webrtc-signal', { ...payload, from: 'baby' });
      } else if (socket.data.role === 'parent' && registry.authenticateParent(session, socket.data.parentId, payload.token, socket.id)) {
        io.to(session.babySocketId).emit('webrtc-signal', { ...payload, parentId: socket.data.parentId, from: 'parent' });
      }
    });

    socket.on('set-baby-microphone', (payload = {}, ack) => {
      const session = registry.getSession(payload.sessionId);
      if (!registry.authenticateParent(session, payload.parentId, payload.parentToken, socket.id)) return ackError(ack, 'UNAUTHORIZED');
      session.micEnabled = Boolean(payload.enabled);
      io.to(session.babySocketId).emit('set-baby-microphone', { enabled: session.micEnabled });
      io.to(`session:${session.id}`).emit('baby-microphone-state', { enabled: session.micEnabled });
      ack?.({ ok: true, enabled: session.micEnabled });
    });

    socket.on('set-detection', (payload = {}, ack) => {
      const session = registry.getSession(payload.sessionId);
      if (!registry.authenticateParent(session, payload.parentId, payload.parentToken, socket.id)) return ackError(ack, 'UNAUTHORIZED');
      session.detection = {
        cry: payload.cry !== false,
        motion: payload.motion !== false,
        sensitivity: ['low', 'medium', 'high'].includes(payload.sensitivity) ? payload.sensitivity : 'medium',
        cooldown: Math.max(10, Math.min(120, Number(payload.cooldown) || 20))
      };
      io.to(`session:${session.id}`).emit('detection-settings', session.detection);
      ack?.({ ok: true, detection: session.detection });
    });

    socket.on('detection-event', (payload = {}) => {
      const session = registry.getSession(payload.sessionId);
      if (!registry.authenticateBaby(session, payload.token, socket.id)) return;
      const allowed = ['cry', 'motion'];
      if (!allowed.includes(payload.type)) return;
      io.to(`session:${session.id}`).emit('detection-event', {
        id: crypto.randomUUID(), type: payload.type, confidence: Math.max(0, Math.min(1, Number(payload.confidence) || 0)), at: Date.now()
      });
    });

    socket.on('environment-status', (payload = {}) => {
      const session = registry.getSession(payload.sessionId);
      if (!registry.authenticateBaby(session, payload.token, socket.id)) return;
      const luminance = Math.max(0, Math.min(255, Number(payload.luminance) || 0));
      session.environment = { luminance, lowLight: luminance < 52 };
      socket.to(`session:${session.id}`).emit('environment-status', session.environment);
    });

    socket.on('end-session', (payload = {}, ack) => {
      const session = registry.getSession(payload.sessionId);
      if (!registry.authenticateBaby(session, payload.babyToken, socket.id)) return ackError(ack, 'UNAUTHORIZED');
      session.ended = true;
      io.to(`session:${session.id}`).emit('session-ended');
      for (const inviteId of session.activeInviteIds) registry.revokeInvite(session, inviteId);
      ack?.({ ok: true });
    });

    socket.on('diagnostics-request', (payload = {}, ack) => {
      const session = registry.getSession(payload.sessionId);
      const authorized = registry.authenticateBaby(session, payload.token, socket.id)
        || registry.authenticateParent(session, payload.parentId, payload.token, socket.id);
      if (!authorized) return ackError(ack, 'UNAUTHORIZED');
      const liveInvites = [...session.activeInviteIds]
        .map((id) => registry.invitesById.get(id))
        .filter((invite) => invite && !invite.revokedAt && !invite.consumedAt && invite.expiresAt > Date.now());
      ack?.({
        ok: true,
        version: VERSION,
        sessionAgeMs: Date.now() - session.createdAt,
        parentCount: registry.parentCount(session),
        maxParents: MAX_PARENTS,
        availableSlots: registry.slots(session),
        activePairings: liveInvites.length,
        micEnabled: session.micEnabled,
        detection: session.detection,
        environment: session.environment,
        transport: socket.conn.transport.name
      });
    });

    socket.on('disconnect', () => {
      const session = registry.getSession(socket.data?.sessionId);
      if (!session) return;
      if (socket.data.role === 'baby') {
        session.ended = true;
        io.to(`session:${session.id}`).emit('baby-offline');
      } else if (socket.data.role === 'parent') {
        registry.disconnectParent(session, socket.data.parentId);
        io.to(session.babySocketId).emit('parent-disconnected', {
          parentId: socket.data.parentId,
          reconnectUntil: Date.now() + RECONNECT_TTL_MS
        });
        broadcastStatus(session);
      }
    });
  });

  const cleanupTimer = setInterval(() => {
    const changedSessions = registry.removeExpired();
    for (const sessionId of changedSessions) {
      const session = registry.getSession(sessionId);
      if (session) broadcastStatus(session);
    }
    sessionLimiter.clearExpired();
    inviteLimiter.clearExpired();
    joinLimiter.clearExpired();
  }, 15_000);
  cleanupTimer.unref();

  return { app, server, io, registry };
}

if (require.main === module) {
  const { server } = createApplication();
  server.listen(PORT, '0.0.0.0', () => console.log(`BabyMoon ${VERSION} listening on ${PORT}`));
}

module.exports = {
  createApplication,
  SessionRegistry,
  SlidingWindowLimiter,
  constants: { VERSION, MAX_PARENTS, INVITE_TTL_MS, RECONNECT_TTL_MS }
};
