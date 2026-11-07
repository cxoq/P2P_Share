'use strict';

/**
 * Starts the signaling server, then opens a free Cloudflare quick tunnel so the
 * app is reachable from the internet. This is what run.bat launches by default.
 *
 *   node tools/host.js            start server + cloudflared tunnel
 *   node tools/host.js --local    start the server only
 *
 * cloudflared.exe is looked up in the project folder (and on PATH). If it is
 * missing the server still starts locally and the download link is printed.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REQUESTED_PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const MAX_PORT_ATTEMPTS = 25;
const useTunnel = !process.argv.includes('--local') && process.env.ISHARE_NO_TUNNEL !== '1';

let PORT = REQUESTED_PORT;
let LOCAL_URL = `http://localhost:${PORT}`;
const TUNNEL_TIMEOUT_MS = 60_000;
const CLOUDFLARED_DOWNLOAD =
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

let server = null;
let tunnel = null;
let shuttingDown = false;

function log(message = '') {
  process.stdout.write(`${message}\n`);
}

function line() {
  log('------------------------------------------------------------');
}

function probeExistingServer(candidate) {
  return new Promise((resolve) => {
    const request = http.get(`http://localhost:${candidate}/healthz`, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          resolve(false);
          return;
        }
        try {
          resolve(JSON.parse(body).app === 'ishare');
        } catch (error) {
          resolve(false);
        }
      });
    });
    request.on('error', () => resolve(false));
    request.setTimeout(700, () => {
      request.destroy();
      resolve(false);
    });
  });
}

function isPortFree(candidate) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(candidate, '0.0.0.0');
  });
}

async function findFreePort(preferred) {
  for (let candidate = preferred; candidate < preferred + MAX_PORT_ATTEMPTS && candidate <= 65535; candidate += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(candidate)) return candidate;
  }
  return null;
}

function findCloudflared() {
  const names = process.platform === 'win32' ? ['cloudflared.exe', 'cloudflared'] : ['cloudflared'];
  for (const name of names) {
    const candidate = path.join(ROOT, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'cloudflared'; // may still exist on PATH
}

function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  server.on('exit', (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopTunnel();
    log(`\n[host] The server stopped (code ${code ?? 0}).`);
    process.exit(code ?? 0);
  });
}

function waitForServer(timeoutMs = 30_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(`${LOCAL_URL}/healthz`, (response) => {
        response.resume();
        if (response.statusCode === 200) {
          resolve();
          return;
        }
        retry();
      });
      request.on('error', retry);
      request.setTimeout(1000, () => request.destroy());
    };

    const retry = () => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`The server did not answer on ${LOCAL_URL} within 30 seconds.`));
        return;
      }
      setTimeout(attempt, 400);
    };

    attempt();
  });
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch (error) {
    /* Opening a browser is a convenience, never a requirement. */
  }
}

function copyToClipboard(text) {
  if (process.platform !== 'win32') return;
  try {
    const clip = spawn('cmd', ['/c', 'clip'], { stdio: ['pipe', 'ignore', 'ignore'] });
    clip.on('error', () => {});
    clip.stdin.end(text);
  } catch (error) {
    /* ignore */
  }
}

function startTunnel() {
  const bin = findCloudflared();

  if (bin === 'cloudflared' && process.platform === 'win32') {
    log('');
    line();
    log('  cloudflared.exe was not found in this folder.');
    log('  The site is running locally, but it is not public yet.');
    log('');
    log('  To go online, download it once:');
    log(`  ${CLOUDFLARED_DOWNLOAD}`);
    log('  Save it as "cloudflared.exe" next to run.bat and start again.');
    line();
    log('');
    openBrowser(LOCAL_URL);
    return;
  }

  log('\n[host] Opening a Cloudflare tunnel…');

  tunnel = spawn(bin, ['tunnel', '--url', LOCAL_URL, '--no-autoupdate'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let announced = false;
  let errorOutput = '';

  const scan = (chunk, isError) => {
    const text = chunk.toString();
    output += text;
    if (isError) errorOutput += text;
    if (announced) return;

    const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (!match) return;

    announced = true;
    const publicUrl = match[0];
    copyToClipboard(publicUrl);

    log('');
    line();
    log('  Your public link (copied to the clipboard):');
    log(`  ${publicUrl}`);
    line();
    log(`  Local:   ${LOCAL_URL}`);
    log('  Send the public link to the other person.');
    log('  Keep this window open. Press Ctrl+C to stop.');
    log('');
    openBrowser(LOCAL_URL);
  };

  tunnel.stdout.on('data', (chunk) => scan(chunk, false));
  tunnel.stderr.on('data', (chunk) => scan(chunk, true));

  tunnel.on('error', (error) => {
    log(`\n[host] Could not start cloudflared: ${error.message}`);
    log('[host] The site still works locally at ' + LOCAL_URL);
  });

  tunnel.on('exit', (code) => {
    if (shuttingDown) return;
    if (!announced) {
      log('\n[host] The tunnel closed before a public link appeared.');
      const detail = errorOutput.trim().split('\n').slice(-6).join('\n');
      if (detail) log(detail);
      log(`[host] The site still works locally at ${LOCAL_URL}`);
      return;
    }
    log(`\n[host] The tunnel stopped (code ${code ?? 0}). The site still works locally at ${LOCAL_URL}`);
  });

  setTimeout(() => {
    if (!announced && !shuttingDown && tunnel) {
      log('\n[host] Still waiting for a public link from Cloudflare…');
      log('[host] The site works locally at ' + LOCAL_URL);
    }
  }, TUNNEL_TIMEOUT_MS).unref();
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch (error) {
    try {
      child.kill();
    } catch (ignored) {
      /* already gone */
    }
  }
}

function stopTunnel() {
  if (tunnel) {
    killTree(tunnel);
    tunnel = null;
  }
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('\n[host] Stopping…');
  stopTunnel();
  if (server) killTree(server);
  setTimeout(() => process.exit(0), 400);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

async function main() {
  log('');

  let reuseExistingServer = false;
  let availablePort = REQUESTED_PORT;

  if (await probeExistingServer(REQUESTED_PORT)) {
    reuseExistingServer = true;
  } else {
    availablePort = await findFreePort(REQUESTED_PORT);
    if (availablePort === null) {
      log(`[host] No free port found between ${REQUESTED_PORT} and ${REQUESTED_PORT + MAX_PORT_ATTEMPTS - 1}.`);
      log('[host] Close the program using the port or set PORT to a free value.');
      process.exit(1);
      return;
    }
  }

  PORT = availablePort;
  LOCAL_URL = `http://localhost:${PORT}`;

  log('  iShare');
  if (reuseExistingServer) {
    log(`  An iShare server is already running at ${LOCAL_URL}. Reusing it.`);
  } else {
    if (PORT !== REQUESTED_PORT) {
      log(`  Port ${REQUESTED_PORT} is busy; using http://localhost:${PORT} instead.`);
    }
    log(`  Starting the server on ${LOCAL_URL} …`);
    startServer();
  }

  try {
    await waitForServer();
  } catch (error) {
    log(`\n[host] ${error.message}`);
    shutdown();
    return;
  }

  if (useTunnel) {
    startTunnel();
  } else {
    log(`\n  Local only: ${LOCAL_URL}`);
    log('  Press Ctrl+C to stop.');
    openBrowser(LOCAL_URL);
  }
}

main();
