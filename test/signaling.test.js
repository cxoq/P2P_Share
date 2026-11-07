'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { after, before, test } = require('node:test');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const MAX_PEERS = 8;

let child;
let port;
let baseUrl;
let stderr = '';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(url, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) return;
    } catch (error) {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready. STDERR:\n${stderr}`);
}

function openClient(headers = null) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws`,
      headers ? { headers } : undefined,
    );
    const inbox = [];
    const waiters = [];

    function flush() {
      for (let index = 0; index < waiters.length; index += 1) {
        const waiter = waiters[index];
        const foundIndex = inbox.findIndex(waiter.predicate);
        if (foundIndex === -1) continue;
        const [message] = inbox.splice(foundIndex, 1);
        clearTimeout(waiter.timer);
        waiters.splice(index, 1);
        index -= 1;
        waiter.resolve(message);
      }
    }

    socket.on('message', (data) => {
      try {
        inbox.push(JSON.parse(data.toString()));
        flush();
      } catch (error) {
        /* ignore non-JSON */
      }
    });

    socket.once('error', reject);
    socket.once('open', () => {
      const client = {
        socket,
        messages: inbox,
        send(payload) {
          socket.send(JSON.stringify(payload));
        },
        waitFor(predicate, timeout = 2500) {
          return new Promise((resolvePromise, rejectPromise) => {
            const waiter = {
              predicate,
              resolve: resolvePromise,
              timer: setTimeout(() => {
                const index = waiters.indexOf(waiter);
                if (index !== -1) waiters.splice(index, 1);
                rejectPromise(new Error(`Timed out waiting for message. Inbox: ${JSON.stringify(inbox)}`));
              }, timeout),
            };
            waiters.push(waiter);
            flush();
          });
        },
        close() {
          for (const waiter of waiters.splice(0)) {
            clearTimeout(waiter.timer);
          }
          socket.close();
        },
      };
      resolve(client);
    });
  });
}

async function createRoom(client, name = 'Test A') {
  const clientId = `test-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  client.send({ type: 'create', name, clientId });
  const joined = await client.waitFor((message) => message.type === 'joined');
  return { joined, clientId };
}

async function joinRoom(client, room, name, clientId) {
  client.send({ type: 'join', room, name, clientId });
  return client.waitFor((message) => message.type === 'joined' || message.type === 'error');
}

before(async () => {
  port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;

  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      HOST: '127.0.0.1',
      MAX_ROOM_PEERS: String(MAX_PEERS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.stdout.on('data', () => {
    /* drain */
  });

  await waitForServer(baseUrl);
});

after(async () => {
  if (!child) return;
  child.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2500);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
});

test('health, config, QR and static security headers work', async () => {
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');

  const config = await fetch(`${baseUrl}/api/config`);
  const configBody = await config.json();
  assert.equal(config.status, 200);
  assert.equal(configBody.maxPeers, MAX_PEERS);
  assert.ok(Array.isArray(configBody.iceServers));
  assert.ok(configBody.iceServers.length >= 1);

  const index = await fetch(`${baseUrl}/`);
  const html = await index.text();
  assert.equal(index.status, 200);
  assert.match(html, /iShare/);
  assert.match(index.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(index.headers.get('x-frame-options'), 'DENY');

  const qrUrl = `${baseUrl}/?room=ABC123`;
  const qr = await fetch(`${baseUrl}/api/qr?text=${encodeURIComponent(qrUrl)}`);
  assert.equal(qr.status, 200);
  assert.equal(qr.headers.get('content-type'), 'image/png');
  assert.ok((await qr.arrayBuffer()).byteLength > 500);

  const foreignQr = await fetch(
    `${baseUrl}/api/qr?text=${encodeURIComponent('https://evil.example/?room=ABC123')}`,
  );
  assert.equal(foreignQr.status, 400);
});

test('serves time-limited TURN credentials without leaking the shared secret', async () => {
  const turnPort = await getFreePort();
  const secret = 'test-turn-shared-secret';
  const turnChild = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(turnPort),
      HOST: '127.0.0.1',
      TURN_URLS:
        'turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp',
      TURN_SECRET: secret,
      TURN_TTL: '600',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  turnChild.stdout.on('data', () => {});
  turnChild.stderr.on('data', () => {});

  try {
    await waitForServer(`http://127.0.0.1:${turnPort}`);
    const response = await fetch(`http://127.0.0.1:${turnPort}/api/config`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();

    assert.equal(body.turnMode, 'dynamic');
    assert.equal(body.iceTtl, 600);
    assert.equal(body.iceTransportPolicy, 'all');

    const turn = body.iceServers.find((server) =>
      [server.urls].flat().some((url) => /^turns?:/i.test(url)),
    );
    assert.ok(turn, 'TURN server should be advertised');
    assert.match(turn.username, /^\d+:ishare$/);
    assert.match(turn.username.split(':')[0], /^\d+$/);

    const expires = Number(turn.username.split(':')[0]);
    const now = Math.floor(Date.now() / 1000);
    assert.ok(expires >= now + 580 && expires <= now + 620, `unexpected expiry ${expires}`);

    const expected = crypto.createHmac('sha1', secret).update(turn.username).digest('base64');
    assert.equal(turn.credential, expected);
    assert.ok(!JSON.stringify(body).includes(secret), 'secret must never be serialized');

    // Static credentials must not be mixed in when dynamic signing is enabled.
    assert.equal(turn.username.includes(secret), false);
  } finally {
    turnChild.kill();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2500);
      turnChild.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
});

test('creates a room, joins, relays SDP/ICE and handles leave', async () => {
  const a = await openClient();
  const b = await openClient();

  try {
    const { joined: aJoined } = await createRoom(a, 'Alpha');
    assert.match(aJoined.room, /^[A-Z0-9]{6}$/);
    assert.equal(aJoined.peers.length, 0);
    assert.equal(aJoined.self.name, 'Alpha');

    const peerJoinedPromise = a.waitFor(
      (message) => message.type === 'peer-joined' && message.peer.name === 'Beta',
    );
    const bJoinedMessage = await joinRoom(b, aJoined.room, 'Beta', `test-beta-${Date.now()}`);
    assert.equal(bJoinedMessage.type, 'joined');
    assert.equal(bJoinedMessage.peers.length, 1);
    assert.equal(bJoinedMessage.peers[0].name, 'Alpha');

    const peerJoined = await peerJoinedPromise;
    assert.equal(peerJoined.peer.name, 'Beta');

    const offerSdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
    const offerPromise = a.waitFor(
      (message) => message.type === 'signal' && message.signal.kind === 'offer',
    );
    b.send({
      type: 'signal',
      to: bJoinedMessage.peers[0].id,
      signal: { kind: 'offer', sdp: offerSdp },
    });
    const offer = await offerPromise;
    assert.equal(offer.from, bJoinedMessage.self.id);
    assert.equal(offer.signal.sdp, offerSdp);

    const answerSdp = 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
    const answerPromise = b.waitFor(
      (message) => message.type === 'signal' && message.signal.kind === 'answer',
    );
    a.send({
      type: 'signal',
      to: offer.from,
      signal: { kind: 'answer', sdp: answerSdp },
    });
    const answer = await answerPromise;
    assert.equal(answer.signal.sdp, answerSdp);

    const candidatePayload = {
      candidate: 'candidate:1 1 UDP 2122260223 192.168.1.2 54321 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };
    const candidatePromise = a.waitFor(
      (message) => message.type === 'signal' && message.signal.kind === 'candidate',
    );
    b.send({
      type: 'signal',
      to: bJoinedMessage.peers[0].id,
      signal: { kind: 'candidate', candidate: candidatePayload },
    });
    const candidate = await candidatePromise;
    assert.deepEqual(candidate.signal.candidate, candidatePayload);

    const leftPromise = a.waitFor((message) => message.type === 'peer-left');
    b.send({ type: 'leave' });
    const left = await leftPromise;
    assert.equal(left.peerId, bJoinedMessage.self.id);
    await b.waitFor((message) => message.type === 'left');
  } finally {
    a.close();
    b.close();
  }
});

test('rejects invalid rooms, unauthorized signals and malformed messages', async () => {
  const client = await openClient();
  try {
    client.send({ type: 'join', room: 'ABC', name: 'Bad', clientId: `bad-${Date.now()}` });
    const invalid = await client.waitFor((message) => message.type === 'error');
    assert.equal(invalid.code, 'INVALID_ROOM');

    client.send({ type: 'join', room: 'ZZZZZZ', name: 'Bad', clientId: `bad2-${Date.now()}` });
    const missing = await client.waitFor((message) => message.type === 'error');
    assert.equal(missing.code, 'ROOM_NOT_FOUND');

    client.send({ type: 'signal', to: 'nobody', signal: { kind: 'offer', sdp: 'v=0' } });
    const noRoom = await client.waitFor((message) => message.type === 'error');
    assert.equal(noRoom.code, 'NOT_IN_ROOM');

    client.socket.send('{not-json');
    const badJson = await client.waitFor((message) => message.type === 'error');
    assert.equal(badJson.code, 'INVALID_JSON');

    client.send({ type: 'nope' });
    const unknown = await client.waitFor((message) => message.type === 'error');
    assert.equal(unknown.code, 'UNKNOWN_MESSAGE');
  } finally {
    client.close();
  }
});

test('serves the CSP for its own origin only and keeps HSTS off plain HTTP', async () => {
  const response = await fetch(`${baseUrl}/`);
  const csp = response.headers.get('content-security-policy') || '';
  assert.match(csp, new RegExp(`connect-src 'self' ws://127\\.0\\.0\\.1:${port} wss://127\\.0\\.0\\.1:${port}`));
  assert.equal(response.headers.get('strict-transport-security'), null);
  assert.match(response.headers.get('referrer-policy') || '', /strict-origin/);
  assert.match(response.headers.get('permissions-policy') || '', /camera=\(\)/);
});

test('rejects cross-origin websocket upgrades but accepts same-origin ones', async () => {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Origin: 'https://evil.example' },
    });
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      try {
        assert.equal(response.statusCode, 403);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.once('open', () => {
      socket.close();
      reject(new Error('Cross-origin upgrade was accepted'));
    });
    socket.once('error', () => {
      /* unexpected-response owns the assertion */
    });
  });

  const sameOrigin = await openClient({ Origin: baseUrl });
  try {
    sameOrigin.send({ type: 'ping' });
    const pong = await sameOrigin.waitFor((message) => message.type === 'pong');
    assert.equal(pong.type, 'pong');
  } finally {
    sameOrigin.close();
  }
});

test('never serves server files or unknown API routes', async () => {
  for (const path of ['/server.js', '/..%2fserver.js', '/%2e%2e/server.js', '/package.json']) {
    const response = await fetch(`${baseUrl}${path}`);
    const body = await response.text();
    assert.ok(!body.includes('child_process') && !body.includes('createServer'), `${path} leaked source`);
    assert.ok(
      !String(response.headers.get('content-type')).includes('javascript'),
      `${path} was served as JavaScript`,
    );
  }

  const missing = await fetch(`${baseUrl}/api/nope`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'not_found' });

  const badQr = await fetch(`${baseUrl}/api/qr?text=${encodeURIComponent('ftp://127.0.0.1/x')}`);
  assert.equal(badQr.status, 400);
});

test('rate limits a single abusive websocket connection', async () => {
  const client = await openClient();
  try {
    for (let index = 0; index < 200; index += 1) {
      client.send({ type: 'ping' });
    }
    const limited = await client.waitFor(
      (message) => message.type === 'error' && message.code === 'RATE_LIMIT',
      5000,
    );
    assert.equal(limited.code, 'RATE_LIMIT');
  } finally {
    client.close();
  }
});

test('gives a second tab with the same clientId its own identity without kicking the first', async () => {
  const a = await openClient();
  const b = await openClient();

  try {
    const { joined: aJoined, clientId } = await createRoom(a, 'Original');
    const peerJoinedPromise = a.waitFor(
      (message) => message.type === 'peer-joined' && message.peer.name === 'Copycat',
    );
    const bJoin = await joinRoom(b, aJoined.room, 'Copycat', clientId);
    assert.equal(bJoin.type, 'joined');
    assert.notEqual(bJoin.self.id, aJoined.self.id, 'duplicate clientId must get a fresh peer id');
    assert.equal(bJoin.resumed, false);

    const peerJoined = await peerJoinedPromise;
    assert.equal(peerJoined.peer.id, bJoin.self.id);
    a.send({ type: 'ping' });
    assert.equal((await a.waitFor((message) => message.type === 'pong')).type, 'pong');

    // The duplicate tab can still resume its own identity after a drop.
    const assignedId = bJoin.self.id;
    b.close();
    await a.waitFor((message) => message.type === 'peer-offline' || message.type === 'peer-left');
    const bReconnect = await openClient();
    try {
      const resumed = await joinRoom(bReconnect, aJoined.room, 'Copycat', assignedId);
      assert.equal(resumed.type, 'joined');
      assert.equal(resumed.resumed, true);
      assert.equal(resumed.self.id, assignedId);
    } finally {
      bReconnect.close();
    }
  } finally {
    a.close();
    b.close();
  }
});

test('enforces the 8-device room capacity and allows reconnects during the grace window', async () => {
  const a = await openClient();
  const joiners = [];
  const joinResults = [];
  const overflow = await openClient();
  let bReconnect;
  let bId;

  try {
    const { joined: room } = await createRoom(a, 'Capacity A');
    for (let index = 1; index < MAX_PEERS; index += 1) {
      const client = await openClient();
      joiners.push(client);
      const joined = await joinRoom(client, room.room, `Capacity ${index}`, `cap-${index}-${Date.now()}`);
      assert.equal(joined.type, 'joined', `peer ${index} should fit`);
      joinResults.push(joined);
    }
    const full = await joinRoom(overflow, room.room, 'Capacity Overflow', `cap-full-${Date.now()}`);
    assert.equal(full.type, 'error');
    assert.equal(full.code, 'ROOM_FULL');

    // Drop the second device's socket without leaving. The room retains the
    // session briefly, so the same id can resume inside the grace window.
    const b = joiners[0];
    bId = joinResults[0].self.id;
    b.close();
    await a.waitFor((message) => message.type === 'peer-offline' || message.type === 'peer-left');

    bReconnect = await openClient();
    const resumed = await joinRoom(bReconnect, room.room, 'Capacity 1', bId);
    assert.equal(resumed.type, 'joined');
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.self.id, bId);

    // An explicit leave frees a slot for the waiting device.
    const c = joiners[1];
    c.send({ type: 'leave' });
    await c.waitFor((message) => message.type === 'left');
    const retry = await joinRoom(overflow, room.room, 'Capacity Overflow', `cap-retry-${Date.now()}`);
    assert.equal(retry.type, 'joined');
  } finally {
    a.close();
    for (const client of joiners) client.close();
    bReconnect?.close();
    overflow.close();
  }
});
