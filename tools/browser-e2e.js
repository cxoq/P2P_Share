'use strict';

/**
 * iShare — browser end-to-end suite.
 *
 * Two or more headless Chromium pages (Edge/Chrome) exercise the real UI and a
 * real WebRTC datachannel:
 *   1. room create/join, text, 2 MB file, QR endpoint, console cleanliness
 *   2. 50 MB file with byte-for-byte verification
 *   3. receiver rejects a file
 *   4. sender cancels during sending
 *   5. three-device mesh with multi-recipient text and file transfer
 *   6. tab reload resumes the signaling session
 *   7. WebSocket drop/reconnect keeps the P2P session
 *   8. keyboard flow, mobile layout, accessible names, reduced motion, axe-core
 *
 * Run with: npm run test:e2e
 * BROWSER_PATH overrides browser detection. If no Chromium is installed the
 * script prints SKIP and exits 0. axe-core is optional; without it the
 * accessibility audit prints SKIP.
 */

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findBrowser() {
  const candidates = [
    process.env.BROWSER_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function loadAxe() {
  try {
    return fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  } catch (error) {
    return null;
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitHttp(url, attempts = 200) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch (error) {
      /* retry */
    }
    await sleep(100);
  }
  throw new Error(`Service did not answer: ${url}`);
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('CDP socket failed')));
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
        return;
      }
      const listeners = this.handlers.get(message.method);
      if (!listeners) return;
      for (const listener of listeners) listener(message.params);
    });
  }

  on(method, listener) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(listener);
  }

  async send(method, params = {}) {
    await this.opened;
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`Page error: ${detail}`);
    }
    return result.result.value;
  }

  close() {
    try {
      this.ws.close();
    } catch (error) {
      /* ignore */
    }
  }
}

async function waitFor(page, expression, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await page.evaluate(expression);
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await sleep(120);
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(last)}`);
}

async function openPage(env) {
  const response = await fetch(`http://127.0.0.1:${env.debugPort}/json/new?about:blank`, { method: 'PUT' });
  if (!response.ok) throw new Error(`Could not open CDP target: ${response.status}`);
  const target = await response.json();
  const page = new Cdp(target.webSocketDebuggerUrl);
  page.targetId = target.id;
  page.errors = [];
  for (const domain of ['Page', 'Runtime', 'DOM', 'Network', 'Log']) {
    await page.send(`${domain}.enable`);
  }
  page.on('Runtime.exceptionThrown', (params) => {
    const detail = params.exceptionDetails;
    page.errors.push(`exception: ${detail.exception?.description || detail.text}`);
  });
  page.on('Log.entryAdded', (params) => {
    if (params.entry.level === 'error') page.errors.push(`log: ${params.entry.text}`);
  });
  page.on('Network.responseReceived', (params) => {
    if (params.response.status >= 400) {
      page.errors.push(`http ${params.response.status} ${params.response.url}`);
    }
  });
  return page;
}

async function closePage(env, page) {
  page.close();
  try {
    await fetch(`http://127.0.0.1:${env.debugPort}/json/close/${page.targetId}`);
  } catch (error) {
    /* the browser may already be gone */
  }
}

async function goto(page, url) {
  await page.send('Page.navigate', { url });
  await waitFor(page, "document.readyState === 'complete' && !!document.getElementById('btn-create')", 'page load');
  await waitFor(page, "document.getElementById('signal-status').dataset.state === 'online'", 'signaling online');
}

async function openPages(env, count) {
  const pages = [];
  for (let index = 0; index < count; index += 1) {
    const page = await openPage(env);
    await goto(page, env.baseUrl + '/');
    pages.push(page);
  }
  return pages;
}

const ROOM_CODE_EXPR = `(() => {
  const view = document.getElementById('view-room');
  const code = document.getElementById('room-code-display').textContent.trim();
  return view && !view.hidden && /^[A-Z0-9]{6}$/.test(code) ? code : '';
})()`;

async function createRoom(page, name) {
  await page.evaluate(`(() => {
    document.getElementById('device-name').value = ${JSON.stringify(name)};
    document.getElementById('btn-create').click();
  })()`);
  return waitFor(page, ROOM_CODE_EXPR, 'room creation');
}

async function joinRoom(env, page, code, name) {
  await page.send('Page.navigate', { url: `${env.baseUrl}/?room=${code}` });
  await waitFor(
    page,
    `document.readyState === 'complete' && document.getElementById('room-input').value === '${code}'`,
    'invite page',
  );
  await waitFor(page, "document.getElementById('signal-status').dataset.state === 'online'", 'signaling online');
  await page.evaluate(`(() => {
    document.getElementById('device-name').value = ${JSON.stringify(name)};
    document.getElementById('btn-join').click();
  })()`);
  await waitFor(page, `document.getElementById('room-code-display').textContent.trim() === '${code}'`, 'room joined');
}

function onlinePeersExpr(count) {
  return `[...document.querySelectorAll('#peer-list .peer:not(.peer--self)')].filter((li) => li.dataset.state === 'online').length === ${count}`;
}

async function waitConnected(pages, peersPerPage) {
  for (const page of pages) {
    await waitFor(page, onlinePeersExpr(peersPerPage), `connected peers (${peersPerPage})`, 30000);
  }
}

async function sendText(page, text) {
  await page.evaluate(`(() => {
    const input = document.getElementById('text-input');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-send-text').click();
  })()`);
}

async function waitText(page, text, label = 'text delivery') {
  await waitFor(
    page,
    `[...document.querySelectorAll('#message-list .message__text')].some((node) => node.textContent.includes(${JSON.stringify(text)}))`,
    label,
  );
}

async function disableSavePicker(page) {
  await page.evaluate(`(() => {
    try {
      Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    } catch (error) { /* ignore */ }
  })()`);
}

async function selectFile(page, filePath) {
  const documentNode = await page.send('DOM.getDocument', { depth: 1 });
  const inputNode = await page.send('DOM.querySelector', {
    nodeId: documentNode.root.nodeId,
    selector: '#file-input',
  });
  if (!inputNode.nodeId) throw new Error('file input not found');
  await page.send('DOM.setFileInputFiles', { nodeId: inputNode.nodeId, files: [filePath] });
}

function makeFixture(size, seed = 1) {
  const buffer = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) buffer[index] = (index * 31 + seed * 17) % 251;
  return buffer;
}

function writeFixture(dir, name, buffer) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

async function waitForDownload(dir, expectedHash, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const done = files.find((name) => !name.endsWith('.crdownload'));
    if (done) {
      const bytes = fs.readFileSync(path.join(dir, done));
      if (expectedHash) {
        if (crypto.createHash('sha256').update(bytes).digest('hex') === expectedHash) return bytes;
      } else {
        return bytes;
      }
    }
    await sleep(150);
  }
  throw new Error(`Download did not finish: ${dir}`);
}

function transferStatusExpr(direction, status) {
  return `(() => {
    const items = [...document.querySelectorAll('#transfer-list .transfer[data-direction="${direction}"]')];
    return items[items.length - 1]?.dataset.status === '${status}';
  })()`;
}

const LAST_TRANSFER = (direction) => `(() => {
  const items = [...document.querySelectorAll('#transfer-list .transfer[data-direction="${direction}"]')];
  return items[items.length - 1] || null;
})()`;

function assertClean(pages, label) {
  const problems = pages.flatMap((page) => page.errors);
  if (problems.length > 0) {
    throw new Error(`${label}: browser reported ${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenarioBaseline(env) {
  const [a, b] = await openPages(env, 2);
  try {
    const code = await createRoom(a, 'Alpha');
    await joinRoom(env, b, code, 'Beta');
    await waitConnected([a, b], 1);

    const netMode = await a.evaluate("document.getElementById('net-chip').dataset.mode");
    if (netMode !== 'stun') throw new Error(`Expected STUN badge in the test server, got ${netMode}`);
    await waitFor(
      a,
      `(() => {
        const node = document.querySelector('#peer-list .peer:not(.peer--self) .peer__status');
        return !!node && /^Connected/.test(node.textContent);
      })()`,
      'peer connected label',
      10000,
    );
    const routeLabel = await a.evaluate(
      "document.querySelector('#peer-list .peer:not(.peer--self) .peer__status').textContent",
    );
    console.log(`  PASS connection route label (${routeLabel}) and STUN network badge`);

    const marker = `text-${Date.now()}`;
    await sendText(a, marker);
    await waitText(b, marker, 'text on Beta');
    console.log('  PASS text A→B');

    const qrUrl = `${env.baseUrl}/?room=${code}`;
    const qr = await fetch(`${env.baseUrl}/api/qr?text=${encodeURIComponent(qrUrl)}`);
    if (qr.status !== 200 || qr.headers.get('content-type') !== 'image/png') {
      throw new Error(`QR endpoint failed: ${qr.status} ${qr.headers.get('content-type')}`);
    }
    if ((await qr.arrayBuffer()).byteLength < 500) throw new Error('QR image too small');
    const foreignQr = await fetch(
      `${env.baseUrl}/api/qr?text=${encodeURIComponent('https://evil.example/?room=' + code)}`,
    );
    if (foreignQr.status !== 400) throw new Error(`QR host binding failed: ${foreignQr.status}`);
    console.log('  PASS QR endpoint and host binding');

    const fixture = makeFixture(2 * 1024 * 1024 + 123, 3);
    const filePath = writeFixture(env.tmpDir, 'baseline.bin', fixture);
    const downloadDir = path.join(env.tmpDir, 'download-baseline');
    fs.mkdirSync(downloadDir, { recursive: true });
    await disableSavePicker(b);
    await b.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true });

    await selectFile(a, filePath);
    await waitFor(b, "!!document.querySelector('[data-transfer-action=\"accept\"]')", 'accept button');
    await b.evaluate("document.querySelector('[data-transfer-action=\"accept\"]').click()");
    await waitFor(b, transferStatusExpr('in', 'complete'), 'receiver complete', 60000);
    await waitFor(a, transferStatusExpr('out', 'complete'), 'sender complete', 60000);
    const hash = crypto.createHash('sha256').update(fixture).digest('hex');
    await waitForDownload(downloadDir, hash, 30000);
    console.log('  PASS 2 MB file byte-verified');

    await b.evaluate("document.getElementById('btn-leave').click()");
    await waitFor(b, "!document.getElementById('view-landing').hidden", 'landing after leave');
    await waitFor(a, onlinePeersExpr(0), 'peer removed after leave');
    const sessionRoom = await b.evaluate("sessionStorage.getItem('ishare:room')");
    if (sessionRoom) throw new Error(`Leave did not clear the stored room: ${sessionRoom}`);
    console.log('  PASS leave clears the room on both sides');

    assertClean([a, b], 'baseline');
    console.log('  PASS no console/CSP/404 errors');
  } finally {
    await closePage(env, a);
    await closePage(env, b);
  }
}

async function scenarioLargeFile(env) {
  const [a, b] = await openPages(env, 2);
  try {
    const code = await createRoom(a, 'Big Sender');
    await joinRoom(env, b, code, 'Big Receiver');
    await waitConnected([a, b], 1);

    const size = 50 * 1024 * 1024 + 17;
    const fixture = makeFixture(size, 5);
    const filePath = writeFixture(env.tmpDir, 'large-50mb.bin', fixture);
    const downloadDir = path.join(env.tmpDir, 'download-large');
    fs.mkdirSync(downloadDir, { recursive: true });
    await disableSavePicker(b);
    await b.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true });

    const started = Date.now();
    await selectFile(a, filePath);
    await waitFor(b, "!!document.querySelector('[data-transfer-action=\"accept\"]')", 'accept button');
    await b.evaluate("document.querySelector('[data-transfer-action=\"accept\"]').click()");
    await waitFor(b, transferStatusExpr('in', 'complete'), '50 MB receiver complete', 180000);
    await waitFor(a, transferStatusExpr('out', 'complete'), '50 MB sender complete', 180000);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const percentages = await a.evaluate(
      "[...document.querySelectorAll('#transfer-list .transfer .transfer__percent')].map((n) => n.textContent)",
    );
    if (!percentages.some((value) => value === '100%')) throw new Error(`Sender never reached 100%: ${percentages}`);
    const hash = crypto.createHash('sha256').update(fixture).digest('hex');
    await waitForDownload(downloadDir, hash, 60000);
    console.log(`  PASS 50 MB (${(size / 1024 / 1024).toFixed(1)} MB) in ${seconds}s, sha256 verified`);
    assertClean([a, b], 'large file');
  } finally {
    await closePage(env, a);
    await closePage(env, b);
  }
}

async function scenarioReject(env) {
  const [a, b] = await openPages(env, 2);
  try {
    const code = await createRoom(a, 'Declining Sender');
    await joinRoom(env, b, code, 'Declining Receiver');
    await waitConnected([a, b], 1);

    const fixture = makeFixture(1024 * 1024, 7);
    const filePath = writeFixture(env.tmpDir, 'reject.bin', fixture);
    await selectFile(a, filePath);
    await waitFor(b, "!!document.querySelector('[data-transfer-action=\"reject\"]')", 'reject button');
    await b.evaluate("document.querySelector('[data-transfer-action=\"reject\"]').click()");

    await waitFor(a, transferStatusExpr('out', 'rejected'), 'sender rejected');
    await waitFor(b, transferStatusExpr('in', 'rejected'), 'receiver rejected');
    const senderLabel = await a.evaluate(
      "document.querySelector('#transfer-list .transfer .transfer__status')?.textContent",
    );
    if (!/declined/i.test(senderLabel || '')) throw new Error(`Unexpected reject label: ${senderLabel}`);
    await sleep(500);
    const senderStatus = await a.evaluate(
      "document.querySelector('#transfer-list .transfer')?.dataset.status",
    );
    if (senderStatus !== 'rejected') throw new Error(`Sender status changed after reject: ${senderStatus}`);
    console.log('  PASS file rejection propagates to the sender');
    assertClean([a, b], 'reject');
  } finally {
    await closePage(env, a);
    await closePage(env, b);
  }
}

async function scenarioCancel(env) {
  const [a, b] = await openPages(env, 2);
  try {
    const code = await createRoom(a, 'Cancelling');
    await joinRoom(env, b, code, 'Cancelled');
    await waitConnected([a, b], 1);

    // Phase 1: cancel while the receiver has not accepted yet.
    const earlyFixture = makeFixture(1024 * 1024, 9);
    const earlyPath = writeFixture(env.tmpDir, 'cancel-before-accept.bin', earlyFixture);
    await selectFile(a, earlyPath);
    await waitFor(b, "!!document.querySelector('[data-transfer-action=\"reject\"]')", 'offer before cancel');
    await a.evaluate("document.querySelector('[data-transfer-action=\"cancel\"]').click()");
    await waitFor(a, transferStatusExpr('out', 'cancelled'), 'sender cancelled before accept', 15000);
    await waitFor(b, transferStatusExpr('in', 'cancelled'), 'receiver cancelled before accept', 15000);
    console.log('  PASS cancel before accept reaches the receiver');

    // Phase 2: cancel after accept, while chunks are in flight.
    const size = 80 * 1024 * 1024 + 5;
    const fixture = makeFixture(size, 11);
    const filePath = writeFixture(env.tmpDir, 'cancel-80mb.bin', fixture);
    await disableSavePicker(b);
    await selectFile(a, filePath);
    await waitFor(b, "!!document.querySelector('[data-transfer-action=\"accept\"]')", 'accept button');
    await b.evaluate("document.querySelector('[data-transfer-action=\"accept\"]').click()");

    await waitFor(
      a,
      `(() => {
        const items = [...document.querySelectorAll('#transfer-list .transfer[data-direction="out"]')];
        const last = items[items.length - 1];
        return last && ['sending', 'awaiting-ack'].includes(last.dataset.status);
      })()`,
      'sender started sending',
      60000,
    );
    const before = await a.evaluate(`(() => {
      const items = [...document.querySelectorAll('#transfer-list .transfer[data-direction="out"]')];
      return items[items.length - 1]?.dataset.status;
    })()`);
    await a.evaluate(`(() => {
      const items = [...document.querySelectorAll('#transfer-list .transfer[data-direction="out"]')];
      items[items.length - 1].querySelector('[data-transfer-action="cancel"]').click();
    })()`);
    await waitFor(a, transferStatusExpr('out', 'cancelled'), 'sender cancelled', 15000);
    await waitFor(b, transferStatusExpr('in', 'cancelled'), 'receiver cancelled', 15000);
    const receiverLabel = await b.evaluate(`(() => {
      const items = [...document.querySelectorAll('#transfer-list .transfer[data-direction="in"]')];
      return items[items.length - 1]?.querySelector('.transfer__status')?.textContent;
    })()`);
    if (!/cancel/i.test(receiverLabel || '')) throw new Error(`Unexpected receiver cancel label: ${receiverLabel}`);
    console.log(`  PASS cancel during ${before} reaches the receiver`);
    assertClean([a, b], 'cancel');
  } finally {
    await closePage(env, a);
    await closePage(env, b);
  }
}

async function scenarioAcceptTimeout(env) {
  const a = await openPage(env);
  await a.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.__ISHARE_TEST_ACCEPT_TIMEOUT_MS = 1200;',
  });
  await goto(a, env.baseUrl + '/');
  const b = await openPage(env);
  await goto(b, env.baseUrl + '/');
  try {
    const code = await createRoom(a, 'Timeout A');
    await joinRoom(env, b, code, 'Timeout B');
    await waitConnected([a, b], 1);

    const fixture = makeFixture(512 * 1024, 17);
    const filePath = writeFixture(env.tmpDir, 'accept-timeout.bin', fixture);
    await selectFile(a, filePath);
    await waitFor(b, "!!document.querySelector('[data-transfer-action=\"accept\"]')", 'offer for timeout');
    await waitFor(a, transferStatusExpr('out', 'error'), 'sender accept timeout', 15000);
    const senderError = await a.evaluate(`(() => {
      const items = [...document.querySelectorAll('#transfer-list .transfer[data-direction="out"]')];
      return items[items.length - 1]?.querySelector('.transfer__status')?.textContent;
    })()`);
    if (!/did not respond|timed out/i.test(senderError || '')) {
      throw new Error(`Unexpected accept-timeout label: ${senderError}`);
    }
    await waitFor(b, transferStatusExpr('in', 'cancelled'), 'receiver cancelled by timeout', 15000);
    console.log('  PASS accept timeout cancels the offer on both sides');
    assertClean([a, b], 'accept timeout');
  } finally {
    await closePage(env, a);
    await closePage(env, b);
  }
}

const DC_PROBE = `(() => {
  window.__ishareTestChannels = [];
  const Native = window.RTCPeerConnection;
  class ProbedPeerConnection extends Native {
    constructor(...args) {
      super(...args);
      this.addEventListener('datachannel', (event) => {
        window.__ishareTestChannels.push(event.channel);
      });
    }
    createDataChannel(...args) {
      const channel = super.createDataChannel(...args);
      window.__ishareTestChannels.push(channel);
      return channel;
    }
  }
  Object.defineProperty(window, 'RTCPeerConnection', {
    value: ProbedPeerConnection,
    configurable: true,
    writable: true,
  });
})()`;

async function scenarioChannelClosed(env) {
  const [a] = await openPages(env, 1);
  const b = await openPage(env);
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: DC_PROBE });
  await goto(b, env.baseUrl + '/');
  try {
    const code = await createRoom(a, 'Kanal A');
    await joinRoom(env, b, code, 'Kanal B');
    await waitConnected([a, b], 1);

    const size = 80 * 1024 * 1024 + 3;
    const fixture = makeFixture(size, 19);
    const filePath = writeFixture(env.tmpDir, 'channel-80mb.bin', fixture);
    await disableSavePicker(b);
    await selectFile(a, filePath);
    await waitFor(b, "!!document.querySelector('[data-transfer-action=\"accept\"]')", 'accept before channel close');
    await b.evaluate("document.querySelector('[data-transfer-action=\"accept\"]').click()");
    await waitFor(
      a,
      `(() => {
        const items = [...document.querySelectorAll('#transfer-list .transfer[data-direction="out"]')];
        return items[items.length - 1]?.dataset.status === 'sending';
      })()`,
      'transfer running before channel close',
      60000,
    );

    const closed = await b.evaluate(`(() => {
      const channel = (window.__ishareTestChannels || []).find((dc) => dc.readyState === 'open');
      if (!channel) return false;
      channel.close();
      return true;
    })()`);
    if (!closed) throw new Error('No open data channel probe was available');

    await waitFor(a, transferStatusExpr('out', 'error'), 'sender sees channel close', 20000);
    await waitFor(b, transferStatusExpr('in', 'error'), 'receiver sees channel close', 20000);
    const messages = await Promise.all(
      [a, b].map((page) =>
        page.evaluate(`(() => {
          const items = [...document.querySelectorAll('#transfer-list .transfer')];
          return items[items.length - 1]?.querySelector('.transfer__status')?.textContent;
        })()`),
      ),
    );
    for (const message of messages) {
      if (!/channel|connection/i.test(message || '')) throw new Error(`Unexpected channel-close label: ${message}`);
    }
    console.log('  PASS data channel close fails the transfer cleanly on both sides');

    // Manual recovery path: the retry control rebuilds the transport and the
    // channel must become usable again without a page reload.
    const retried = await b.evaluate(`(() => {
      const button = [...document.querySelectorAll('#peer-list .peer:not(.peer--self) .peer__retry')]
        .find((node) => !node.hidden);
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!retried) throw new Error('Retry button was not available after the channel closed');
    await waitConnected([a, b], 1);
    const retryMarker = `retry-${Date.now()}`;
    await sendText(b, retryMarker);
    await waitText(a, retryMarker, 'text after manual retry');
    console.log('  PASS manual retry renegotiates and restores the channel');

    assertClean([a, b], 'channel close');
  } finally {
    await closePage(env, a);
    await closePage(env, b);
  }
}

async function scenarioMesh(env) {
  const [a, b, c] = await openPages(env, 3);
  try {
    const code = await createRoom(a, 'Mesh A');
    await joinRoom(env, b, code, 'Mesh B');
    await joinRoom(env, c, code, 'Mesh C');
    await waitConnected([a, b, c], 2);
    console.log('  PASS three devices fully meshed');

    const marker = `mesh-${Date.now()}`;
    await sendText(a, marker);
    await waitText(b, marker, 'mesh text on B');
    await waitText(c, marker, 'mesh text on C');
    console.log('  PASS multi-recipient text A→B,C');

    const fixture = makeFixture(1024 * 1024 + 9, 13);
    const filePath = writeFixture(env.tmpDir, 'mesh.bin', fixture);
    await disableSavePicker(b);
    await disableSavePicker(c);
    await selectFile(a, filePath);

    for (const page of [b, c]) {
      await waitFor(page, "!!document.querySelector('[data-transfer-action=\"accept\"]')", 'mesh accept button');
      await page.evaluate("document.querySelector('[data-transfer-action=\"accept\"]').click()");
    }
    for (const page of [b, c]) {
      await waitFor(page, transferStatusExpr('in', 'complete'), 'mesh receiver complete', 60000);
    }
    const senderTransfers = await a.evaluate(
      "[...document.querySelectorAll('#transfer-list .transfer[data-direction=\"out\"]')].map((el) => el.dataset.status)",
    );
    if (senderTransfers.length !== 2 || senderTransfers.some((status) => status !== 'complete')) {
      throw new Error(`Mesh sender statuses: ${JSON.stringify(senderTransfers)}`);
    }
    const receiverSizes = await Promise.all(
      [b, c].map((page) =>
        page.evaluate("document.querySelector('#transfer-list .transfer .transfer__size')?.textContent"),
      ),
    );
    for (const text of receiverSizes) {
      if (!text || !/^1.0+ MB/.test(text)) throw new Error(`Unexpected receiver size: ${text}`);
    }
    console.log('  PASS multi-recipient file A→B,C');
    assertClean([a, b, c], 'mesh');
  } finally {
    await closePage(env, a);
    await closePage(env, b);
    await closePage(env, c);
  }
}

async function scenarioReloadResume(env) {
  const [a, b] = await openPages(env, 2);
  try {
    const code = await createRoom(a, 'Persistent A');
    await joinRoom(env, b, code, 'Yenilenen B');
    await waitConnected([a, b], 1);

    await sendText(a, `before-reload-${Date.now()}`);
    const before = await b.evaluate(
      "[...document.querySelectorAll('#message-list .message__text')].length",
    );
    const peerIdBefore = await a.evaluate(
      "document.querySelector('#peer-list .peer:not(.peer--self)')?.dataset.peerId",
    );
    const clientIdBefore = await b.evaluate("sessionStorage.getItem('ishare:client-id')");

    await b.send('Page.reload');
    await waitFor(b, ROOM_CODE_EXPR, 'auto rejoin after reload', 30000);
    await waitFor(b, onlinePeersExpr(1), 'peer reconnected after reload', 30000);
    await waitFor(a, onlinePeersExpr(1), 'peer still connected on A', 30000);

    const peerCount = await a.evaluate(
      "document.querySelectorAll('#peer-list .peer:not(.peer--self)').length",
    );
    const peerIdAfter = await a.evaluate(
      "document.querySelector('#peer-list .peer:not(.peer--self)')?.dataset.peerId",
    );
    const clientIdAfter = await b.evaluate("sessionStorage.getItem('ishare:client-id')");
    if (peerCount !== 1) throw new Error(`Reload left ${peerCount} peer entries on A`);
    if (peerIdAfter !== peerIdBefore) throw new Error('Reload created a new peer identity instead of resuming');
    if (clientIdAfter !== clientIdBefore) throw new Error('Client id was not preserved across reload');
    if (before < 1) throw new Error('Message history was empty before reload');

    const marker = `after-reload-${Date.now()}`;
    await sendText(a, marker);
    await waitText(b, marker, 'text after reload');
    console.log('  PASS reload resumes session and keeps the datachannel working');
  } finally {
    await closePage(env, a);
    await closePage(env, b);
  }
}

const WS_PROBE = `(() => {
  const Native = window.WebSocket;
  window.__wsInstances = [];
  class ProbedWebSocket extends Native {
    constructor(...args) {
      super(...args);
      window.__wsInstances.push(this);
    }
  }
  Object.defineProperty(window, 'WebSocket', {
    value: ProbedWebSocket,
    configurable: true,
    writable: true,
  });
})()`;

async function scenarioSignalingReconnect(env) {
  // Install a WebSocket probe before the app boots so the test can drop the
  // signaling socket exactly like a lost network connection would.
  const a = await openPage(env);
  await a.send('Page.addScriptToEvaluateOnNewDocument', { source: WS_PROBE });
  await goto(a, env.baseUrl + '/');
  const b = await openPage(env);
  await goto(b, env.baseUrl + '/');
  try {
    const code = await createRoom(a, 'Sinyal A');
    await joinRoom(env, b, code, 'Sinyal B');
    await waitConnected([a, b], 1);
    const peerIdBefore = await b.evaluate(
      "document.querySelector('#peer-list .peer:not(.peer--self)')?.dataset.peerId",
    );

    const closed = await a.evaluate(`(() => {
      const sockets = window.__wsInstances || [];
      const socket = sockets[sockets.length - 1];
      if (!socket) return false;
      socket.close();
      return true;
    })()`);
    if (!closed) throw new Error('No probed signaling socket was available');
    await waitFor(a, "document.getElementById('signal-status').dataset.state !== 'online'", 'signal drop', 10000);
    console.log('  PASS signaling socket drop detected');

    await waitFor(a, "document.getElementById('signal-status').dataset.state === 'online'", 'signal reconnect', 30000);
    await waitFor(a, onlinePeersExpr(1), 'peer after signaling reconnect', 45000);
    const socketsAfter = await a.evaluate('(window.__wsInstances || []).length');
    const peerIdAfter = await b.evaluate(
      "document.querySelector('#peer-list .peer:not(.peer--self)')?.dataset.peerId",
    );
    if (socketsAfter < 2) throw new Error('Client did not open a replacement signaling socket');
    if (peerIdAfter !== peerIdBefore) throw new Error('Signaling reconnect changed the peer identity');

    const marker = `after-signal-drop-${Date.now()}`;
    await sendText(a, marker);
    await waitText(b, marker, 'text after signaling reconnect');
    console.log('  PASS signaling reconnect resumes the session and the datachannel');
  } finally {
    await closePage(env, a);
    await closePage(env, b);
  }
}

const KEY_CODES = { Tab: 9, Enter: 13 };
async function pressKey(page, key, modifiers = 0) {
  const code = KEY_CODES[key] || 0;
  const text = key === 'Enter' ? '\r' : undefined;
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code: key,
    text,
    unmodifiedText: text,
    windowsVirtualKeyCode: code,
    nativeVirtualKeyCode: code,
    modifiers,
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code: key,
    windowsVirtualKeyCode: code,
    nativeVirtualKeyCode: code,
    modifiers,
  });
}

async function scenarioAccessibility(env) {
  const [a, b] = await openPages(env, 2);
  try {
    // Keyboard-only room creation: name → Tab → Enter on "Create a room".
    await a.evaluate("document.getElementById('device-name').focus()");
    await a.send('Input.insertText', { text: 'Klavye A' });
    await pressKey(a, 'Tab');
    const focused = await a.evaluate("document.activeElement.id");
    if (focused !== 'btn-create') throw new Error(`Tab did not reach create button (focused ${focused})`);
    await pressKey(a, 'Enter');
    const code = await waitFor(a, ROOM_CODE_EXPR, 'keyboard room creation');

    // Keyboard-only join: name → Tab → Tab → Enter on the focused room code field's form.
    await b.send('Page.navigate', { url: `${env.baseUrl}/?room=${code}` });
    await waitFor(b, "document.readyState === 'complete' && document.getElementById('room-input').value === '" + code + "'", 'join page');
    await waitFor(b, "document.getElementById('signal-status').dataset.state === 'online'", 'join signaling');
    await b.evaluate("document.getElementById('device-name').focus()");
    await b.send('Input.insertText', { text: 'Klavye B' });
    await pressKey(b, 'Tab');
    const second = await b.evaluate("document.activeElement.id");
    if (second !== 'btn-create') throw new Error(`Second tab stop was ${second}`);
    await pressKey(b, 'Tab');
    const third = await b.evaluate("document.activeElement.id");
    if (third !== 'room-input') throw new Error(`Third tab stop was ${third}`);
    await pressKey(b, 'Enter');
    await waitFor(b, `document.getElementById('room-code-display').textContent.trim() === '${code}'`, 'keyboard join');
    await waitConnected([a, b], 1);
    console.log('  PASS keyboard-only create and join');

    const marker = `keyboard-${Date.now()}`;
    await a.evaluate("document.getElementById('text-input').focus()");
    await a.send('Input.insertText', { text: marker });
    await pressKey(a, 'Enter', 2); // Ctrl+Enter
    await waitText(b, marker, 'keyboard text send');
    console.log('  PASS Ctrl+Enter sends text');

    const missingNames = await a.evaluate(`(() => {
      const controls = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), textarea, select, [role="button"]')];
      const nameOf = (el) => {
        const aria = el.getAttribute('aria-label');
        if (aria && aria.trim()) return aria.trim();
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const text = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
          if (text) return text;
        }
        if (el.id) {
          const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
          if (label && label.textContent.trim()) return label.textContent.trim();
        }
        const wrapping = el.closest('label');
        if (wrapping && wrapping.textContent.trim()) return wrapping.textContent.trim();
        const text = (el.innerText || '').trim();
        if (text) return text;
        return (el.getAttribute('title') || '').trim();
      };
      return controls
        .filter((el) => el.offsetParent !== null && !el.disabled && el.tabIndex !== -1)
        .filter((el) => !nameOf(el))
        .map((el) => el.outerHTML.slice(0, 120));
    })()`);
    if (missingNames.length > 0) throw new Error(`Controls without accessible names: ${JSON.stringify(missingNames)}`);
    console.log('  PASS all visible controls have accessible names');

    await a.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await sleep(300);
    const overflow = await a.evaluate(
      "({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth })",
    );
    await a.send('Emulation.clearDeviceMetricsOverride');
    if (overflow.scroll > overflow.inner + 1) {
      throw new Error(`Horizontal overflow on mobile: ${JSON.stringify(overflow)}`);
    }
    console.log('  PASS no horizontal overflow at 390px');

    await a.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    const reduced = await a.evaluate(`(() => {
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const orbit = document.querySelector('.orbit__ring');
      const duration = orbit ? getComputedStyle(orbit).animationDuration : '0s';
      return { reduced, duration };
    })()`);
    await a.send('Emulation.setEmulatedMedia', { features: [] });
    const seconds = parseFloat(reduced.duration);
    if (!reduced.reduced || !(seconds <= 0.01)) {
      throw new Error(`Reduced motion not applied: ${JSON.stringify(reduced)}`);
    }
    console.log('  PASS prefers-reduced-motion is honoured');

    const axeSource = loadAxe();
    if (!axeSource) {
      console.log('  SKIP axe-core not installed (npm install axe-core)');
    } else {
      await a.evaluate(axeSource);
      const result = await a.evaluate(`axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
      }).then((r) => ({ violations: r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        targets: v.nodes.map((node) => node.target.join(' ')),
      })) }))`);
      const serious = result.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
      if (serious.length > 0) throw new Error(`axe violations: ${JSON.stringify(serious)}`);
      console.log(`  PASS axe-core (${result.violations.length} non-serious violations)`);
    }

    assertClean([a, b], 'accessibility');
  } finally {
    await closePage(env, a);
    await closePage(env, b);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) {
    console.log('SKIP: Chromium (Edge/Chrome) not found. Set BROWSER_PATH to run the browser suite.');
    return;
  }

  const serverPort = await getFreePort();
  const debugPort = await getFreePort();
  const tmpDir = path.join(os.tmpdir(), `ishare-e2e-${Date.now()}`);
  const profileDir = path.join(tmpDir, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const env = {
    baseUrl: `http://127.0.0.1:${serverPort}`,
    debugPort,
    tmpDir,
    profileDir,
  };

  let server;
  let browser;

  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(serverPort),
        HOST: '127.0.0.1',
        // Keep browser scenarios deterministic: a developer's local .env may
        // point at a real TURN server that is unreachable from CI.
        TURN_URLS: '',
        TURN_SECRET: '',
        TURN_USERNAME: '',
        TURN_CREDENTIAL: '',
        ICE_SERVERS_JSON: '',
        ICE_TRANSPORT_POLICY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let serverStderr = '';
    server.stderr.on('data', (chunk) => {
      serverStderr += chunk.toString();
    });
    await waitHttp(`${env.baseUrl}/healthz`);

    browser = spawn(
      browserPath,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-dev-shm-usage',
        '--disable-background-timer-throttling',
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${profileDir}`,
        'about:blank',
      ],
      { stdio: 'ignore', windowsHide: true },
    );
    await waitHttp(`http://127.0.0.1:${debugPort}/json/version`);

    const scenarios = [
      ['baseline', scenarioBaseline],
      ['large file', scenarioLargeFile],
      ['reject', scenarioReject],
      ['cancel', scenarioCancel],
      ['accept timeout', scenarioAcceptTimeout],
      ['channel closed', scenarioChannelClosed],
      ['mesh', scenarioMesh],
      ['reload resume', scenarioReloadResume],
      ['signaling reconnect', scenarioSignalingReconnect],
      ['accessibility', scenarioAccessibility],
    ];

    const only = process.env.E2E_ONLY && process.env.E2E_ONLY.trim();
    for (const [name, scenario] of scenarios) {
      if (only && name !== only) continue;
      console.log(`\n▶ ${name}`);
      await scenario(env);
    }

    console.log('\nE2E OK');
    if (serverStderr.trim()) {
      console.log('Server stderr (expected warnings, if any):');
      console.log(serverStderr.trim());
    }
  } finally {
    try {
      browser?.kill();
    } catch (error) {
      /* ignore */
    }
    try {
      server?.kill();
    } catch (error) {
      /* ignore */
    }
    await sleep(500);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 });
    } catch (error) {
      /* Windows may keep profile files locked for a moment */
    }
  }
}

main().catch((error) => {
  console.error(`\nE2E FAILED: ${error.message}`);
  process.exitCode = 1;
});
