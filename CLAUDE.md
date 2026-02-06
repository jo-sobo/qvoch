# CLAUDE.md — QVoCh Project Intelligence

## Project Overview
QVoCh (Quick Voice Channel) — ephemeral self-hosted voice chat.
Go backend (Pion WebRTC SFU) + React TypeScript frontend. Single Docker container. No database.
Full spec: `.dev_local/specs/SPEC_FINAL.md`

## Build & Run Commands
- Backend: `go run .` from repo root (serves on :17223)
- Frontend dev: `cd web && npm run dev` (Vite dev server with proxy to :17223)
- Frontend build: `cd web && npm run build` (output to web/dist/)
- Docker build: `docker build -t qvoch .`
- Docker run: `docker run -p 17223:17223 -p 40000-40100:40000-40100/udp -e PUBLIC_IP=localhost qvoch`

## Code Style & Conventions
- Go: standard gofmt, unexported mutex fields (`mu sync.RWMutex`), error wrapping with `fmt.Errorf("context: %w", err)`
- TypeScript: strict mode, no `any` types, functional components only, Zustand for state
- Naming: Go uses `PascalCase` exports / `camelCase` internal. TS uses `camelCase` functions / `PascalCase` components & types.
- All WebSocket message types defined in `internal/sfu/signals.go` (Go) and `web/src/types/index.ts` (TS) — keep these in sync

## Architecture Rules
- Server-initiated SDP offers ALWAYS. Client never creates offers, only answers.
- PeerConnection teardown + rebuild on room transitions. Never attempt renegotiation.
- Password is MANDATORY for room creation. No passwordless rooms.
- Chat is ALWAYS E2E encrypted (AES-256-GCM, PBKDF2-derived from password + roomFullName).
- Server only stores/relays ciphertext. Server never sees plaintext chat or raw passwords.
- All state is in-memory. No database, no file persistence. Container restart = clean slate.
- Sub-channels use the same E2E key as parent main channel.
- Max sub-channel depth: 1. No nested sub-channels.

## Concurrency Rules (Go)
- Always lock Hub.mu before accessing Hub.Rooms, Hub.RoomsByName, Hub.InviteMap, Hub.SessionMap
- Always lock Room.mu before accessing Room.Peers, Room.SubChannels, Room.ChatHistory
- Always lock Peer.mu before accessing Peer.Conn, Peer.PC, Peer.Track
- Lock ordering to prevent deadlocks: Hub.mu -> Room.mu -> Peer.mu (never reverse)
- Never hold a lock while doing blocking I/O (WebSocket write, PeerConnection operations)

## Mistakes & Lessons Learned
- **[Go/peer]:** Peer.mu is unexported, so cross-package access requires exported Lock/RLock/Unlock/RUnlock methods on Peer.
- **[Go/hub]:** broadcastRoomUpdate must be exported as BroadcastRoomUpdatePublic for use from handlers package.
- **[Go/webrtc]:** WebRTC API must be lazily initialized on Hub (stored as webrtcAPI field) since the Hub is created before env vars are fully processed.
- **[Go/webrtc]:** OnTrack handler writes to the peer's own TrackLocalStaticRTP — all PCs that added this track automatically receive the forwarded RTP.
- **[Go/webrtc]:** Must add a recvonly transceiver to receive audio from client before creating the offer.
- **[Go/gorilla]:** Gorilla websocket requires serialized writes — use a separate writeMu mutex, never lock Peer.mu during writes.
- **[TS/tailwind]:** Tailwind v4 uses `@import "tailwindcss"` and `@theme {}` blocks instead of v3's `@tailwind` directives and `tailwind.config.js`.
- **[TS/crypto]:** Web Crypto API PBKDF2 importKey must use 'PBKDF2' algorithm name (not 'raw'), and key must not be extractable. Derived key should be extractable for localStorage caching.
- **[TS/vite]:** Vite proxy for WebSocket requires explicit `ws: true` in proxy config.
- **[build]:** The go.mod minimum Go version gets auto-upgraded by `go mod tidy` to match installed Go version (e.g., 1.24.0 from 1.21).

## Dependencies & Versions
- Go 1.21+, pion/webrtc v3, gorilla/websocket, google/uuid, x/crypto/bcrypt
- React 18, Vite, TypeScript strict, Tailwind CSS, Zustand, Lucide-React
- Web Crypto API for AES-256-GCM + PBKDF2 (no external crypto library)
