# iShare

**Send files and text directly between browsers.** No uploads, no cloud storage.

iShare is a small WebRTC file-transfer app. Two browsers connect directly and
data travels over an encrypted data channel. The Node.js server only relays the
WebRTC handshake (offer, answer, ICE candidates) — it never sees your files.

---

## Features

- **Peer to peer:** files and messages go browser to browser, not through the server.
- **Streamed transfers:** files are sent in 64 KB chunks, so large files don't have to fit in memory.
- **Room invites:** a 6-character room code, a shareable link, and a QR code.
- **Up to 8 devices per room** in a mesh, so you can send to everyone at once.
- **Clean UI:** simple light and dark themes, English interface, works on desktop and mobile.
- **File accept/decline** on the receiving side, with progress, speed, and cancel support.
- **Resilient:** reconnects the signaling socket and tries an ICE restart if the connection drops.
- **Safe defaults:** strict CSP, origin checks, message size limits, rate limiting, and XSS-safe rendering.

---

## Quick start (Windows)

1. Install [Node.js](https://nodejs.org/) 18.17 or newer (LTS is fine).
2. For a public link, download
   [cloudflared.exe](https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe)
   and put it in this folder, next to `run.bat`.
3. Double-click **`run.bat`**.

The script installs dependencies on first run, starts the server, opens
`http://localhost:3000`, and — if `cloudflared.exe` is present — creates a free
Cloudflare tunnel. The public link is printed in the window and copied to your
clipboard:

```
Your public link (copied to the clipboard):
https://something-random.trycloudflare.com
```

Send that link to the other person. One of you clicks **Create a room**, shares
the 6-character code, and the other joins with it.

Keep the window open while you use the tunnel. The address changes each time you
start. If port 3000 is already taken, iShare uses the next free port; if an
iShare server is already running on 3000, `run.bat` reuses it.

To start without the tunnel: `run.bat --local`

### From a terminal

```bash
npm install
npm start
```

Then open `http://localhost:3000`. To test locally, open two tabs: create a room
in one and join it in the other.

---

## Sharing over the internet

The server needs a long-running Node.js process with WebSocket support, so
static hosting and classic serverless functions won't work.

- **Quick tunnel (no account):** use `run.bat` as above. Works while your
  computer is on and the window stays open.
- **Cloud host (always online):** deploy to Render, Railway, Fly.io, or a VPS.
  The address stays the same and keeps working while your computer is off.

### Render

1. Push the repository to GitHub.
2. Create **New → Web Service** and select the repository.
3. Build command: `npm ci` · Start command: `npm start` · Health check: `/healthz`
4. Add any environment variables you need (see below), then deploy.

Render provides HTTPS and WSS automatically; the app picks `wss://` based on the
page protocol. The free plan sleeps after 15 idle minutes, so the first visit
can take 30–60 seconds and rooms are cleared while asleep.

### Docker / Fly.io

```bash
docker build -t ishare .
docker run --rm -p 3000:3000 --env-file .env ishare
```

With Fly.io, keep a single always-on machine (`fly scale count 1`,
`--autostop=false`); idle shutdown loses in-memory rooms.

### Reverse proxy

Forward WebSocket upgrades. Caddy does this automatically:

```caddyfile
share.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

---

## TURN (recommended for some networks)

STUN is enough on most home networks. Symmetric NAT, corporate firewalls, and
some mobile carriers block direct peer-to-peer connections, in which case a TURN
server is required. TURN relays encrypted WebRTC packets without being able to
read them.

Set these variables to enable it:

| Variable | Description |
| --- | --- |
| `TURN_URLS` | Comma-separated TURN/TURNS URLs |
| `TURN_SECRET` | coturn `static-auth-secret`; the server then issues short-lived credentials |
| `TURN_TTL` | Credential lifetime in seconds (default `3600`) |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | Static credentials, if you don't use `TURN_SECRET` |

An example coturn configuration is in `deploy/coturn/turnserver.conf`.

---

## Configuration

Copy `.env.example` to `.env` to set these locally. The server loads `.env`
automatically.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP/WebSocket port |
| `HOST` | `0.0.0.0` | Interface to bind |
| `MAX_ROOM_PEERS` | `8` | Devices per room (2–20) |
| `MAX_CONNECTIONS` | `500` | Concurrent WebSocket connections (1–100000) |
| `ALLOWED_ORIGINS` | empty | Extra comma-separated origins; the same origin is always allowed |
| `ICE_TRANSPORT_POLICY` | `all` | Set to `relay` to force TURN-only connections |
| `ICE_SERVERS_JSON` | empty | Full `iceServers` JSON array, overriding the TURN settings |

---

## Privacy and limits

- Files never reach the server; only JSON signaling messages do.
- The data channel is encrypted with DTLS between the browsers.
- The room code is the access key. Share it only with the people you trust.
- The server can see the room code, display names, SDP/ICE messages, and
  connection metadata, but not file contents or text messages.
- Rooms live in memory and are deleted when empty. Nothing is persisted.
- A disconnected peer is kept in the room for 15 seconds to allow a reconnect.

Browsers: Chrome/Edge 90+, Firefox 90+, Safari 15.4+. On browsers without the
File System Access API (Firefox, Safari), received files are assembled in memory
before download, so very large transfers may be limited by memory.

---

## Project layout

```
server.js                 Express + ws signaling server, QR, security headers
public/
  index.html              UI markup and templates
  styles.css              Light and dark themes
  theme.js                Pre-paint theme selection
  protocol.js             Pure validation helpers (unit tested)
  app.js                  WebRTC engine, chunking, transfer UI
tools/
  host.js                 Starts the server and the Cloudflare tunnel
  browser-e2e.js          Headless browser end-to-end suite
test/                     Protocol and signaling tests
deploy/coturn/            Example coturn configuration
run.bat                   Windows one-click launcher
Dockerfile                Container image
```

---

## Testing

```bash
npm run check      # syntax checks
npm test           # unit and signaling integration tests
npm run test:e2e   # headless Chromium end-to-end suite
```

The E2E suite needs Edge or Chrome installed. If none is found it skips
cleanly; set `BROWSER_PATH` to point at a specific browser.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `EADDRINUSE` | Another process owns the port. `run.bat` picks the next free one automatically; or set `PORT` to a free value. |
| "Server offline" in the UI | Make sure `npm start` is running and the port/firewall allows it. |
| Room not found | Check the 6-character code. Empty rooms are deleted; create a new one. |
| Devices won't connect | The network may block P2P. Configure TURN. Some corporate/mobile networks require it. |
| Transfer stalls | Check the browser console for WebRTC errors and reload both tabs. |
| File won't save | The receiver may have cancelled the save dialog or run out of disk space. |
| Very large file runs out of memory | Firefox/Safari buffer downloads in memory. Use Chrome/Edge over HTTPS for direct-to-disk streaming. |
| LAN IP doesn't work but localhost does | Allow Node.js on private networks in Windows Firewall. |

---

## License

MIT.
