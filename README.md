# QVoCh

**Quick Voice Channel** — a self-hosted, ephemeral voice chat application. No accounts, no database, no tracking. Create a room, share the link, chat and talk.

## Features

- **Voice chat** via WebRTC SFU (Selective Forwarding Unit)
- **E2E encrypted text chat** using AES-256-GCM with PBKDF2-derived keys
- **Zero accounts** — pick a display name and join
- **Ephemeral** — all state lives in memory, rooms are destroyed after inactivity
- **Sub-channels** — invite users to private breakout rooms
- **Single container** — one Docker image serves frontend, signaling, and media relay
- **Site passphrase** — optional access control without user accounts
- **GIF & emoji support** via Giphy integration
- **Auto-rejoin on reload/network drops** via session token restore

## Quick Start

### Docker (recommended)

```bash
# Build image (native platform)
IMAGE_TAG="qvoch"
./scripts/docker-build.sh "$IMAGE_TAG"

# Optional: force amd64 build (for x86_64 servers/registries)
DOCKER_DEFAULT_PLATFORM=linux/amd64 ./scripts/docker-build.sh "$IMAGE_TAG"

docker run -p 17223:17223 -p 40000-40100:40000-40100/udp \
  -e PUBLIC_IP=your-server-ip \
  "$IMAGE_TAG"
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

All runtime configuration is done via environment variables.
Copy `.env.example` to `.env`, then use `docker run --env-file .env ...` or set variables individually.

### Runtime / container env vars

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `PORT` | `17223` | No | HTTP server port. |
| `SITE_PASSPHRASE` | *(empty)* | No | If set, users must enter this passphrase before accessing the app. |
| `PUBLIC_IP` | *(empty)* | Only on VPS/NAT | Public IP or hostname used for WebRTC NAT traversal (NAT1To1 host candidate advertisement). Leave empty for local dev/LAN. |
| `PUBLIC_IP_RECHECK_INTERVAL` | `0` (disabled) | No | Periodically re-resolve `PUBLIC_IP`. Accepts Go durations (`60s`, `5m`) or integer seconds (`60`). |
| `PUBLIC_IP_RECHECK_REBUILD_PEERS` | `true` | No | If `true`, rebuilds active peer connections when `PUBLIC_IP`/UDP settings change so new ICE host candidates apply immediately. |
| `UDP_MIN` | `40000` | No | WebRTC UDP port range start (0-65535). |
| `UDP_MAX` | `40100` | No | WebRTC UDP port range end (0-65535). |
| `ALLOWED_ORIGINS` | *(empty)* | No | Comma-separated origin allowlist for WebSocket upgrade. Empty means same-origin only (`http(s)://<host>`). |
| `TRUST_PROXY` | `false` | No | Trust proxy headers for client IP extraction. Set exactly `true` behind reverse proxy. |
| `MAX_USERS_PER_ROOM` | `25` | No | Max users per room, bounded to `1..100`. |
| `MAX_ROOMS` | `100` | No | Max concurrent rooms, bounded to `1..10000`. |
| `CHAT_HISTORY_SIZE` | `200` | No | Stored chat messages per room, bounded to `10..1000`. |
| `GIPHY_API_KEY` | *(empty)* | No | Giphy API key injected at container startup (`docker-entrypoint.sh`) into `runtime-config.js`. |

### Frontend dev-only env vars

These are only for running the frontend directly with Vite (`cd web && npm run dev`), not for production container runtime.

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_GIPHY_API_KEY` | *(empty)* | Dev fallback used only when runtime config key is not present. Put it in `web/.env.local`. |

### Build metadata (serverBuildID)

Default local/community builds should be labeled as non-official.
Build ID format:

`non-official-<branch>-<short-commit>-<UTC build time>[-dirty]`

- Example: `non-official-main-a1b2c3d4e5f6-20260208-201530`
- `-dirty` is appended when Go VCS metadata reports local uncommitted changes at build time.

`./scripts/docker-build.sh` always produces non-official build IDs.

The same build ID is used in:
- backend startup log (`build=...`)
- settings footer in the UI
- landing page footer in the UI

Official labels are reserved for maintainer release builds.

### Giphy

To enable GIF search, pass your Giphy API key at container runtime:

```bash
docker run -p 17223:17223 -p 40000-40100:40000-40100/udp \
  -e PUBLIC_IP=your-server-ip \
  -e GIPHY_API_KEY=your-key \
  qvoch
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
