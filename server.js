'use strict';

/**
 * iShare — signaling server
 * ----------------------------
 * This process only brokers WebRTC negotiation between browsers. File bytes and
 * chat messages never touch Express, WebSocket, or the server filesystem.
 */

const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

require('dotenv').config();

const express = require('express');
const QRCode = require('qrcode');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = parseInteger(process.env.PORT, 3000, 0, 65535);
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const MAX_ROOM_PEERS = parseInteger(process.env.MAX_ROOM_PEERS, 8, 2, 20);
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_SDP_BYTES = 24 * 1024;
const MAX_CANDIDATE_BYTES = 8 * 1024;
const MAX_ROOM_TEXT = 700;
const OFFLINE_GRACE_MS = 15_000;
const RATE_WINDOW_MS = 10_000;
const RATE_LIMIT = 180;
const HEARTBEAT_MS = 30_000;
const MAX_CONNECTIONS = parseInteger(process.env.MAX_CONNECTIONS, 500, 1, 100_000);
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const TURN_URLS = String(process.env.TURN_URLS || '')
  .split(',')
  .map((url) => url.trim())
  .filter((url) => /^turns?:/i.test(url))
  .slice(0, 10);
const TURN_USERNAME = String(process.env.TURN_USERNAME || '');
const TURN_CREDENTIAL = String(process.env.TURN_CREDENTIAL || '');
// coturn's `use-auth-secret` mode (TURN REST API): the server signs a
// short-lived username instead of shipping one static password to every
// browser. https://github.com/coturn/coturn/wiki/turnserver
const TURN_SECRET = String(process.env.TURN_SECRET || '');
const TURN_TTL_SECONDS = parseInteger(process.env.TURN_TTL, 3600, 60, 86_400);
const ICE_TRANSPORT_POLICY = String(process.env.ICE_TRANSPORT_POLICY || '').toLowerCase() === 'relay'
  ? 'relay'
  : 'all';
const ROOM_CODE_LENGTH = 6;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PUBLIC_DIR = path.join(__dirname, 'public');
const APP_VERSION = require('./package.json').version;

/** @type {Map<string, {code: string, createdAt: number, members: Map<string, RoomMember>}>} */
const rooms = new Map();

function parseInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function clampText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeRoomCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code.length === ROOM_CODE_LENGTH ? code : null;
}

function normalizeClientId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null;
}

function makeRoomCode() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const bytes = crypto.randomBytes(ROOM_CODE_LENGTH);
    let code = '';
    for (const byte of bytes) code += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
    if (!rooms.has(code)) return code;
  }
  // Extremely unlikely, but never return a duplicate room code.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const fallback = crypto.randomBytes(ROOM_CODE_LENGTH).toString('hex').toUpperCase().slice(0, ROOM_CODE_LENGTH);
    if (fallback.length === ROOM_CODE_LENGTH && !rooms.has(fallback)) return fallback;
  }
  throw new Error('Could not allocate a unique room code');
}

const STUN_SERVERS = [
  {
    urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
  },
];

/** ICE_SERVERS_JSON is an explicit, complete override (no defaults appended). */
const ICE_SERVERS_JSON = (() => {
  if (!process.env.ICE_SERVERS_JSON) return null;
  try {
    const parsed = JSON.parse(process.env.ICE_SERVERS_JSON);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.length <= 20) {
      return parsed;
    }
    console.warn('[config] ICE_SERVERS_JSON must be an array with 1–20 entries; ignoring it.');
  } catch (error) {
    console.warn('[config] ICE_SERVERS_JSON is not valid JSON; falling back to STUN/TURN env vars.');
  }
  return null;
})();

function turnCredentials(nowMs) {
  if (TURN_SECRET) {
    // coturn expects `timestamp` or `timestamp:identifier`; the credential is
    // base64(HMAC-SHA1(secret, username)).
    const expires = Math.floor(nowMs / 1000) + TURN_TTL_SECONDS;
    const username = `${expires}:ishare`;
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    return { username, credential, expires };
  }
  return { username: TURN_USERNAME, credential: TURN_CREDENTIAL, expires: 0 };
}

let warnedTurnMisconfig = false;

function buildIceServers(nowMs = Date.now()) {
  if (ICE_SERVERS_JSON) return { serverList: ICE_SERVERS_JSON, turnMode: 'json', expires: 0 };

  const serverList = STUN_SERVERS.map((server) => ({ ...server, urls: [...server.urls] }));
  let turnMode = 'none';
  let expires = 0;

  if (TURN_URLS.length > 0) {
    if (TURN_SECRET) {
      const { username, credential, expires: validUntil } = turnCredentials(nowMs);
      serverList.push({ urls: [...TURN_URLS], username, credential });
      turnMode = 'dynamic';
      expires = validUntil;
    } else if (TURN_USERNAME && TURN_CREDENTIAL) {
      serverList.push({
        urls: [...TURN_URLS],
        username: TURN_USERNAME,
        credential: TURN_CREDENTIAL,
      });
      turnMode = 'static';
    } else if (!warnedTurnMisconfig) {
      warnedTurnMisconfig = true;
      // TURN without credentials is usually a configuration mistake. Sending
      // it would only add a guaranteed-to-fail candidate family.
      console.warn('[config] TURN_URLS is set but TURN_SECRET or TURN_USERNAME/TURN_CREDENTIAL is missing; TURN disabled.');
    }
  }

  return { serverList, turnMode, expires };
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

function connectSrcFor(req) {
  const host = String(req.headers.host || '');
  const safeHost = /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host) || /^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/.test(host);
  if (!safeHost) return "'self' ws: wss:";
  return `'self' ws://${host} wss://${host}`;
}

app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; " +
      "object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
      `font-src 'self'; connect-src ${connectSrcFor(req)}; manifest-src 'self'; worker-src 'self'`,
  );
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});

app.get('/healthz', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    status: 'ok',
    app: 'ishare',
    version: APP_VERSION,
    rooms: rooms.size,
    uptime: Math.round(process.uptime()),
  });
});

app.get('/api/config', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const ice = buildIceServers();
  res.json({
    version: APP_VERSION,
    maxPeers: MAX_ROOM_PEERS,
    iceServers: ice.serverList,
    iceTransportPolicy: ICE_TRANSPORT_POLICY,
    turnMode: ice.turnMode,
    iceTtl: ice.turnMode === 'dynamic' ? TURN_TTL_SECONDS : 0,
    wsPath: '/ws',
  });
});

app.get('/api/qr', async (req, res) => {
  const text = typeof req.query.text === 'string' ? req.query.text : '';
  const host = req.get('host');

  if (!text || text.length > MAX_ROOM_TEXT) {
    return res.status(400).json({ error: 'invalid_qr_text' });
  }

  let parsed;
  try {
    parsed = new URL(text);
  } catch (error) {
    return res.status(400).json({ error: 'invalid_qr_text' });
  }

  // Keep the QR endpoint from being used to mint codes for arbitrary hosts.
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== host) {
    return res.status(400).json({ error: 'qr_host_mismatch' });
  }

  try {
    const png = await QRCode.toBuffer(parsed.toString(), {
      type: 'png',
      width: 560,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#051015',
        light: '#f2fffd',
      },
    });

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', 'attachment; filename="ishare-room.png"');
    }
    return res.send(png);
  } catch (error) {
    console.error('[qr] generation failed:', error.message);
    return res.status(500).json({ error: 'qr_generation_failed' });
  }
});

app.use(
  express.static(PUBLIC_DIR, {
    index: 'index.html',
    etag: true,
    fallthrough: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
      }
    },
  }),
);

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/ws') return next();
  if (!req.accepts('html')) return next();
  return res.sendFile(path.join(PUBLIC_DIR, 'index.html'), {
    headers: { 'Cache-Control': 'no-cache' },
  });
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'not_found' });
  }
  return res.status(404).type('text/plain').send('Not found');
});

app.use((error, _req, res, _next) => {
  console.error('[http]', error);
  res.status(500).json({ error: 'internal_server_error' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  noServer: true,
  clientTracking: true,
  perMessageDeflate: false,
  maxPayload: MAX_PAYLOAD_BYTES,
});

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // Native clients and server-to-server tools send no Origin.
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch (error) {
    return false;
  }
}

server.on('upgrade', (req, socket, head) => {
  let pathname;
  try {
    pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  } catch (error) {
    socket.destroy();
    return;
  }

  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }

  if (!originAllowed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }

  if (wss.clients.size >= MAX_CONNECTIONS) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

function sendJson(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (error) {
    console.error('[ws] send failed:', error.message);
    return false;
  }
}

function sendError(ctx, code, message, fatal = false) {
  sendJson(ctx.ws, { type: 'error', code, message });
  if (fatal && ctx.ws.readyState === WebSocket.OPEN) {
    ctx.ws.close(1008, code);
  }
}

function broadcast(room, payload, excludeId = null) {
  const serialized = JSON.stringify(payload);
  for (const member of room.members.values()) {
    if (member.id === excludeId) continue;
    if (!member.ws || member.ws.readyState !== WebSocket.OPEN) continue;
    try {
      member.ws.send(serialized);
    } catch (error) {
      console.error('[ws] broadcast failed:', error.message);
    }
  }
}

function publicPeer(member) {
  return {
    id: member.id,
    name: member.name,
    joinedAt: member.joinedAt,
  };
}

function peersOf(room, excludeId) {
  return [...room.members.values()]
    .filter((member) => member.id !== excludeId)
    .map(publicPeer);
}

function joinRoom(ctx, room, name, requestedId) {
  if (ctx.joined) {
    sendError(ctx, 'ALREADY_JOINED', 'You are already in a room.');
    return;
  }

  let id = normalizeClientId(requestedId) || crypto.randomUUID();
  let existing = room.members.get(id);

  if (existing && existing.ws && existing.ws !== ctx.ws && existing.ws.readyState === WebSocket.OPEN) {
    // A copied tab or a second tab can race for the same session id. Give the new
    // socket a fresh identity rather than kicking the healthy one.
    id = crypto.randomUUID();
    existing = null;
  }

  if (!existing && room.members.size >= MAX_ROOM_PEERS) {
    sendError(ctx, 'ROOM_FULL', `Bu oda dolu (en fazla ${MAX_ROOM_PEERS} cihaz).`);
    return;
  }

  const wasResume = Boolean(existing);

  if (existing) {
    if (existing.removeTimer) {
      clearTimeout(existing.removeTimer);
      existing.removeTimer = null;
    }
    existing.ws = ctx.ws;
    existing.name = name;
    existing.lastSeenAt = Date.now();
    existing.offlineSince = null;
  } else {
    existing = {
      id,
      name,
      ws: ctx.ws,
      joinedAt: Date.now(),
      lastSeenAt: Date.now(),
      offlineSince: null,
      removeTimer: null,
    };
    room.members.set(id, existing);
  }

  ctx.joined = true;
  ctx.id = id;
  ctx.roomCode = room.code;
  ctx.name = name;

  sendJson(ctx.ws, {
    type: 'joined',
    room: room.code,
    self: publicPeer(existing),
    peers: peersOf(room, id),
    maxPeers: MAX_ROOM_PEERS,
    resumed: wasResume,
    version: APP_VERSION,
  });

  if (wasResume) {
    broadcast(room, { type: 'peer-online', peer: publicPeer(existing) }, id);
  } else {
    broadcast(room, { type: 'peer-joined', peer: publicPeer(existing) }, id);
  }
}

function createRoomAndJoin(ctx, name, requestedId) {
  if (ctx.joined) {
    sendError(ctx, 'ALREADY_JOINED', 'You are already in a room.');
    return;
  }
  // Reserve the code and join before storing it, so a failed join cannot leak
  // an empty room into the map.
  let code = makeRoomCode();
  while (rooms.has(code)) code = makeRoomCode();
  const room = { code, createdAt: Date.now(), members: new Map() };
  rooms.set(code, room);
  joinRoom(ctx, room, name, requestedId);
  if (room.members.size === 0) rooms.delete(code);
}

function removeMember(room, memberId, { announce = true } = {}) {
  const member = room.members.get(memberId);
  if (!member) return;
  if (member.removeTimer) {
    clearTimeout(member.removeTimer);
    member.removeTimer = null;
  }
  room.members.delete(memberId);
  if (announce) {
    broadcast(room, { type: 'peer-left', peerId: memberId, name: member.name });
  }
  if (room.members.size === 0) {
    rooms.delete(room.code);
  }
}

function detachSocket(ctx) {
  if (!ctx.joined || !ctx.roomCode || !ctx.id) return;
  const room = rooms.get(ctx.roomCode);
  if (!room) return;
  const member = room.members.get(ctx.id);
  if (!member || member.ws !== ctx.ws) return;

  member.ws = null;
  member.offlineSince = Date.now();
  broadcast(room, { type: 'peer-offline', peerId: member.id, name: member.name });

  // Capture the identifiers before clearing ctx below: the grace timer must
  // still be able to find this member after the socket context is reset.
  const roomCode = ctx.roomCode;
  const memberId = ctx.id;

  if (member.removeTimer) clearTimeout(member.removeTimer);
  member.removeTimer = setTimeout(() => {
    const currentRoom = rooms.get(roomCode);
    if (!currentRoom) return;
    const currentMember = currentRoom.members.get(memberId);
    if (!currentMember || currentMember.ws) return;
    removeMember(currentRoom, memberId);
  }, OFFLINE_GRACE_MS);
  if (typeof member.removeTimer.unref === 'function') member.removeTimer.unref();

  ctx.joined = false;
  ctx.id = null;
  ctx.roomCode = null;
}

function handleSignal(ctx, msg) {
  if (!ctx.joined) {
    sendError(ctx, 'NOT_IN_ROOM', 'Join a room before sending signals.');
    return;
  }

  const room = rooms.get(ctx.roomCode);
  if (!room) return;

  const targetId = typeof msg.to === 'string' ? msg.to : '';
  const target = room.members.get(targetId);
  if (!target || targetId === ctx.id || !target.ws || target.ws.readyState !== WebSocket.OPEN) {
    sendError(ctx, 'PEER_UNAVAILABLE', 'The target device is not reachable right now.');
    return;
  }

  const signal = msg.signal;
  if (!signal || typeof signal !== 'object' || Array.isArray(signal)) {
    sendError(ctx, 'INVALID_SIGNAL', 'Invalid signal.');
    return;
  }

  if (signal.kind === 'offer' || signal.kind === 'answer') {
    if (
      typeof signal.sdp !== 'string' ||
      signal.sdp.length === 0 ||
      signal.sdp.length > MAX_SDP_BYTES ||
      !signal.sdp.startsWith('v=0')
    ) {
      sendError(ctx, 'INVALID_SIGNAL', 'Invalid session description.');
      return;
    }
    sendJson(target.ws, {
      type: 'signal',
      from: ctx.id,
      signal: { kind: signal.kind, sdp: signal.sdp },
    });
    return;
  }

  if (signal.kind === 'candidate') {
    const candidate = signal.candidate;
    if (
      candidate !== null &&
      typeof candidate !== 'string' &&
      (typeof candidate !== 'object' || Array.isArray(candidate))
    ) {
      sendError(ctx, 'INVALID_SIGNAL', 'Invalid ICE candidate.');
      return;
    }
    let serializedLength = 0;
    try {
      serializedLength = JSON.stringify(signal).length;
    } catch (error) {
      serializedLength = MAX_CANDIDATE_BYTES + 1;
    }
    if (serializedLength > MAX_CANDIDATE_BYTES) {
      sendError(ctx, 'INVALID_SIGNAL', 'ICE candidate is too large.');
      return;
    }
    sendJson(target.ws, {
      type: 'signal',
      from: ctx.id,
      signal: { kind: 'candidate', candidate },
    });
    return;
  }

  sendError(ctx, 'INVALID_SIGNAL', 'Unknown signal type.');
}

function rateLimitOk(ctx) {
  const now = Date.now();
  if (now - ctx.rateWindowStart >= RATE_WINDOW_MS) {
    ctx.rateWindowStart = now;
    ctx.rateCount = 0;
  }
  ctx.rateCount += 1;
  return ctx.rateCount <= RATE_LIMIT;
}

function handleMessage(ctx, raw) {
  if (!rateLimitOk(ctx)) {
    sendError(ctx, 'RATE_LIMIT', 'Too many requests. Please wait a moment.');
    return;
  }

  let msg;
  try {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    if (Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) {
      sendError(ctx, 'MESSAGE_TOO_LARGE', 'Message is too large.', true);
      return;
    }
    msg = JSON.parse(text);
  } catch (error) {
    sendError(ctx, 'INVALID_JSON', 'Invalid message.');
    return;
  }

  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
    sendError(ctx, 'INVALID_MESSAGE', 'Invalid message structure.');
    return;
  }

  switch (msg.type) {
    case 'create': {
      if (ctx.joined) return sendError(ctx, 'ALREADY_JOINED', 'You are already in a room.');
      const name = clampText(msg.name, 32) || 'Gizemli Cihaz';
      createRoomAndJoin(ctx, name, msg.clientId);
      break;
    }

    case 'join': {
      if (ctx.joined) return sendError(ctx, 'ALREADY_JOINED', 'You are already in a room.');
      const code = normalizeRoomCode(msg.room);
      if (!code) return sendError(ctx, 'INVALID_ROOM', 'Room codes are 6 characters.');
      const room = rooms.get(code);
      if (!room) return sendError(ctx, 'ROOM_NOT_FOUND', 'Room not found or closed.');
      const name = clampText(msg.name, 32) || 'Gizemli Cihaz';
      joinRoom(ctx, room, name, msg.clientId);
      break;
    }

    case 'signal':
      handleSignal(ctx, msg);
      break;

    case 'leave': {
      if (!ctx.joined) return;
      const room = rooms.get(ctx.roomCode);
      const id = ctx.id;
      // Only the socket that currently owns the session may remove it. A
      // reload's best-effort leave can arrive after the replacement socket has
      // already resumed the same member; dropping that late frame keeps the
      // resumed device in the room.
      const member = room?.members.get(id);
      if (room && member && member.ws === ctx.ws) removeMember(room, id);
      ctx.joined = false;
      ctx.id = null;
      ctx.roomCode = null;
      sendJson(ctx.ws, { type: 'left' });
      break;
    }

    case 'ping':
      sendJson(ctx.ws, { type: 'pong', ts: Date.now() });
      break;

    default:
      sendError(ctx, 'UNKNOWN_MESSAGE', 'Unknown message type.');
  }
}

wss.on('connection', (ws) => {
  const ctx = {
    ws,
    joined: false,
    id: null,
    roomCode: null,
    name: null,
    rateWindowStart: Date.now(),
    rateCount: 0,
  };

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('message', (data) => handleMessage(ctx, data));
  ws.on('close', () => detachSocket(ctx));
  ws.on('error', (error) => {
    console.warn('[ws] socket error:', error.message);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (error) {
      ws.terminate();
    }
  }
}, HEARTBEAT_MS);
if (typeof heartbeat.unref === 'function') heartbeat.unref();

function localAddresses() {
  const addresses = [];
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === 'IPv4' && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }
  return [...new Set(addresses)];
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[server] Port ${PORT} is already in use. Set PORT to a free port and try again.`);
  } else {
    console.error(`[server] ${error.message}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  console.log('');
  console.log('  iShare — P2P file transfer');
  console.log(`  Local:    http://${displayHost}:${PORT}`);
  for (const address of localAddresses()) {
    console.log(`  Network:  http://${address}:${PORT}`);
  }
  console.log(`  Health:   http://${displayHost}:${PORT}/healthz`);
  console.log(`  Mode:     ${NODE_ENV}`);
  const turn = buildIceServers();
  console.log(
    `  TURN:     ${
      turn.turnMode === 'dynamic'
        ? `short-lived credentials (${TURN_TTL_SECONDS}s)`
        : turn.turnMode === 'static'
          ? 'static credentials'
          : turn.turnMode === 'json'
            ? 'ICE_SERVERS_JSON'
            : 'none (STUN only)'
    }`,
  );
  console.log('  The server does not carry file data; it only relays the WebRTC handshake.');
  console.log('');
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] ${signal} received, shutting down...`);
  clearInterval(heartbeat);
  for (const ws of wss.clients) {
    try {
      ws.close(1001, 'Server shutting down');
    } catch (error) {
      ws.terminate();
    }
  }
  server.close(() => {
    console.log('[server] Closed.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection:', reason);
});
