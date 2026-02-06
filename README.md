# QVoCh

**Quick Voice Channel** — a self-hosted, ephemeral voice chat application. No accounts, no database, no tracking. Create a room, share the link, talk.

## Features

- **Voice chat** via WebRTC SFU (Selective Forwarding Unit)
- **E2E encrypted text chat** using AES-256-GCM with PBKDF2-derived keys
- **Zero accounts** — pick a display name and join
- **Ephemeral** — all state lives in memory, rooms are destroyed after inactivity
- **Sub-channels** — invite users to private breakout rooms
- **Single container** — one Docker image serves frontend, signaling, and media relay
- **Site passphrase** — optional access control without user accounts
- **GIF & emoji support** via Giphy integration

## Quick Start

### Docker (recommended)

```bash
docker build -t qvoch .
docker run -p 17223:17223 -p 40000-40100:40000-40100/udp \
  -e PUBLIC_IP=your-server-ip \
  qvoch
```

Open `http://localhost:17223` in your browser.

### From source

```bash
# Backend
go run .

# Frontend (dev server with hot reload)
cd web && npm install && npm run dev
```

## Configuration

All configuration is done via environment variables. Copy `.env` and adjust as needed.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `17223` | HTTP server port |
| `PUBLIC_IP` | *(empty)* | Public IP or hostname for WebRTC NAT traversal. Required on a VPS. |
| `UDP_MIN` | `40000` | WebRTC UDP port range start |
| `UDP_MAX` | `40100` | WebRTC UDP port range end |
| `SITE_PASSPHRASE` | *(empty)* | If set, requires passphrase before accessing the app |
| `ALLOWED_ORIGINS` | *(empty)* | Comma-separated CORS allowlist. Empty = same-origin only. |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For` headers (set `true` behind a reverse proxy) |
| `MAX_USERS_PER_ROOM` | `25` | Max users per room (1-100) |
| `MAX_ROOMS` | `100` | Max concurrent rooms (1-10000) |
| `CHAT_HISTORY_SIZE` | `200` | Chat messages stored per room (10-1000) |
| `VITE_GIPHY_API_KEY` | *(empty)* | Giphy API key (build-time, pass as `--build-arg` in Docker) |

### Giphy

To enable GIF search, pass your Giphy API key at build time:

```bash
docker build --build-arg VITE_GIPHY_API_KEY=your-key -t qvoch .
```

### Reverse proxy

QVoCh serves HTTP and expects TLS termination from a reverse proxy (Nginx, Caddy, etc.). Make sure to:

- Proxy TCP port `17223` (HTTP + WebSocket at `/ws`)
- Forward UDP ports `40000-40100` directly (media traffic)
- Set `TRUST_PROXY=true` so rate limiting uses real client IPs
- Set `PUBLIC_IP` to your domain or public IP

## Architecture

```
Browser ──WebSocket──► Go Server ──► Hub ──► Rooms ──► Peers
         (signaling)     │                              │
Browser ◄──────RTP──────►│◄────────────RTP─────────────►│
         (voice audio)   Pion WebRTC SFU
```

- **Backend**: Go with Pion WebRTC for SFU media relay, Gorilla for WebSocket signaling
- **Frontend**: React + TypeScript + Vite, Zustand for state, Tailwind CSS for styling
- **Encryption**: Room passwords are hashed with bcrypt server-side. The same password is used client-side with PBKDF2 to derive an AES-256-GCM key for E2E encrypted chat. The server only stores and relays ciphertext.
- **Voice** is SFU-relayed (not E2E encrypted) for browser compatibility

## Security

- CORS origin validation on WebSocket connections
- Per-IP connection and room creation rate limiting
- Per-connection message rate limiting with abuse disconnect
- SDP and ICE candidate size limits
- Password minimum 6 characters, bcrypt hashed
- Session token expiry (24h), invite token expiry (7d)
- Security headers (CSP, X-Frame-Options, etc.)
- Optional site-wide passphrase authentication

## License

[GNU Affero General Public License v3.0](LICENSE)
