package handlers

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/jonas/qvoch/internal/sfu"
)

var allowedOrigins map[string]bool

func init() {
	allowedOrigins = make(map[string]bool)
	if origins := os.Getenv("ALLOWED_ORIGINS"); origins != "" {
		for _, o := range strings.Split(origins, ",") {
			o = strings.TrimSpace(o)
			if o != "" {
				allowedOrigins[o] = true
			}
		}
		log.Printf("CORS: allowing origins %v", allowedOrigins)
	}
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		if len(allowedOrigins) > 0 {
			return allowedOrigins[origin]
		}
		host := r.Host
		return origin == "http://"+host || origin == "https://"+host
	},
}

var channelNameRegex = regexp.MustCompile(`^[a-zA-Z0-9 \-]+$`)

type rateLimiter struct {
	tokens    int
	lastReset time.Time
	maxRate   int
}

func newRateLimiter(maxRate int) *rateLimiter {
	return &rateLimiter{
		tokens:    maxRate,
		lastReset: time.Now(),
		maxRate:   maxRate,
	}
}

func (rl *rateLimiter) allow() bool {
	now := time.Now()
	elapsed := now.Sub(rl.lastReset)
	if elapsed >= time.Second {
		rl.tokens = rl.maxRate
		rl.lastReset = now
	}
	if rl.tokens <= 0 {
		return false
	}
	rl.tokens--
	return true
}

var (
	connLimiters   = make(map[string]*connLimiterEntry)
	connLimitersMu sync.Mutex
	trustProxy     = os.Getenv("TRUST_PROXY") == "true"
)

type connLimiterEntry struct {
	limiter  *rateLimiter
	lastSeen time.Time
}

func init() {
	go func() {
		for range time.Tick(5 * time.Minute) {
			connLimitersMu.Lock()
			now := time.Now()
			for ip, entry := range connLimiters {
				if now.Sub(entry.lastSeen) > 5*time.Minute {
					delete(connLimiters, ip)
				}
			}
			connLimitersMu.Unlock()
		}
	}()
}

func allowConnection(ip string) bool {
	connLimitersMu.Lock()
	defer connLimitersMu.Unlock()

	entry, ok := connLimiters[ip]
	if !ok {
		entry = &connLimiterEntry{
			limiter: newRateLimiter(3),
		}
		connLimiters[ip] = entry
	}
	entry.lastSeen = time.Now()
	return entry.limiter.allow()
}

func extractIP(r *http.Request) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if i := strings.Index(xff, ","); i > 0 {
				return strings.TrimSpace(xff[:i])
			}
			return strings.TrimSpace(xff)
		}
		if xri := r.Header.Get("X-Real-IP"); xri != "" {
			return strings.TrimSpace(xri)
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

const (
	pingInterval = 30 * time.Second
	pongWait     = 60 * time.Second
	writeWait    = 10 * time.Second
)

func HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	ip := extractIP(r)

	if !allowConnection(ip) {
		log.Printf("SECURITY: conn_rate_limit ip=%s", ip)
		http.Error(w, "Too many connections", http.StatusTooManyRequests)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("websocket upgrade error: %v", err)
		return
	}

	peerID := uuid.New().String()
	peer := &sfu.Peer{
		ID:   peerID,
		Conn: conn,
	}

	log.Printf("peer connected: %s ip=%s", peerID, ip)

	// Ping/pong keepalive: set read deadline and pong handler
	conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	// Start ping ticker goroutine
	pingDone := make(chan struct{})
	go func() {
		ticker := time.NewTicker(pingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := peer.WritePing(time.Now().Add(writeWait)); err != nil {
					return
				}
			case <-pingDone:
				return
			}
		}
	}()

	defer func() {
		close(pingDone)
		hub := sfu.GetHub()
		hub.RemovePeer(peer)
		conn.Close()
		log.Printf("peer disconnected: %s", peerID)
	}()

	hub := sfu.GetHub()
	limiter := newRateLimiter(30)
	violations := 0

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("peer %s: read error: %v", peerID, err)
			}
			break
		}

		if !limiter.allow() {
			violations++
			if violations >= 50 {
				log.Printf("SECURITY: rate_abuse ip=%s peer=%s violations=%d", ip, peerID, violations)
				conn.WriteControl(
					websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "Too many requests"),
					time.Now().Add(time.Second),
				)
				break
			}
			peer.SendError(sfu.ErrInvalidMessage, "Rate limit exceeded")
			continue
		}

		var env sfu.Envelope
		if err := json.Unmarshal(message, &env); err != nil {
			log.Printf("SECURITY: malformed_json ip=%s peer=%s", ip, peerID)
			peer.SendError(sfu.ErrInvalidMessage, "Invalid JSON message")
			continue
		}

		switch env.Type {
		case "create":
			handleCreate(hub, peer, env.Payload, ip)
		case "join":
			handleJoin(hub, peer, env.Payload, ip)
		case "answer":
			handleAnswer(hub, peer, env.Payload)
		case "candidate":
			handleCandidate(hub, peer, env.Payload)
		case "chat":
			handleChat(hub, peer, env.Payload)
		case "mute":
			handleMute(hub, peer, env.Payload)
		case "sub-invite":
			handleSubInvite(hub, peer, env.Payload)
		case "sub-response":
			handleSubResponse(hub, peer, env.Payload)
		case "move-to-main":
			hub.HandleMoveToMain(peer)
		case "move-to-sub":
			handleMoveToSub(hub, peer, env.Payload)
		case "leave":
			hub.RemovePeer(peer)
		default:
			peer.SendError(sfu.ErrInvalidMessage, "Unknown message type: "+env.Type)
		}
	}
}

func validateUsername(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return ""
	}
	if utf8.RuneCountInString(name) > 24 {
		return ""
	}
	return name
}

func validateChannelName(name string) bool {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > 30 {
		return false
	}
	return channelNameRegex.MatchString(name)
}

func validatePassword(pw string) bool {
	return len(pw) >= 6 && len(pw) <= 64
}

func handleCreate(hub *sfu.Hub, peer *sfu.Peer, payload json.RawMessage, ip string) {
	var p sfu.CreatePayload
	if err := json.Unmarshal(payload, &p); err != nil {
		peer.SendError(sfu.ErrInvalidMessage, "Invalid create payload")
		return
	}

	username := validateUsername(p.Username)
	if username == "" {
		peer.SendError(sfu.ErrInvalidMessage, "Username must be 1-24 characters")
		return
	}
	if !validateChannelName(p.ChannelName) {
		peer.SendError(sfu.ErrInvalidMessage, "Channel name must be 1-30 alphanumeric characters, spaces, or hyphens")
		return
	}
	if !validatePassword(p.Password) {
		peer.SendError(sfu.ErrPasswordRequired, "Password must be 6-64 characters")
		return
	}

	peer.Name = username

	room, err := hub.CreateRoom(p.ChannelName, p.Password, peer, ip)
	if err != nil {
		if strings.Contains(err.Error(), "full") || strings.Contains(err.Error(), "limit") {
			log.Printf("SECURITY: room_limit ip=%s detail=%s", ip, err.Error())
		}
		peer.SendError(sfu.ErrInternalError, err.Error())
		return
	}

	peer.RLock()
	sessionToken := peer.SessionToken
	peer.RUnlock()

	welcome := hub.BuildWelcomePayload(peer, room, sessionToken)
	peer.SendJSON("welcome", welcome)

	if err := hub.CreatePeerConnection(peer, room); err != nil {
		log.Printf("failed to create peer connection for %s: %v", peer.ID, err)
		return
	}
	if err := hub.SendOffer(peer); err != nil {
		log.Printf("failed to send offer to %s: %v", peer.ID, err)
	}
}

func handleJoin(hub *sfu.Hub, peer *sfu.Peer, payload json.RawMessage, ip string) {
	var p sfu.JoinPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		peer.SendError(sfu.ErrInvalidMessage, "Invalid join payload")
		return
	}

	username := validateUsername(p.Username)
	if username == "" {
		peer.SendError(sfu.ErrInvalidMessage, "Username must be 1-24 characters")
		return
	}
	p.Username = username

	if p.InviteToken == "" && p.ChannelName == "" && p.SessionToken == "" {
		peer.SendError(sfu.ErrInvalidMessage, "Must provide channelName, inviteToken, or sessionToken")
		return
	}

	if p.InviteToken == "" && p.SessionToken == "" && p.Password != "" && !validatePassword(p.Password) {
		peer.SendError(sfu.ErrInvalidMessage, "Password must be 6-64 characters")
		return
	}

	room, sessionToken, err := hub.JoinRoom(p, peer)
	if err != nil {
		errMsg := err.Error()
		code := sfu.ErrInternalError
		msg := errMsg
		for i := 0; i < len(errMsg); i++ {
			if errMsg[i] == ':' {
				code = errMsg[:i]
				msg = errMsg[i+1:]
				break
			}
		}
		if code == sfu.ErrPasswordWrong {
			log.Printf("SECURITY: wrong_password ip=%s channel=%s", ip, p.ChannelName)
		}
		peer.SendError(code, msg)
		return
	}

	welcome := hub.BuildWelcomePayload(peer, room, sessionToken)
	peer.SendJSON("welcome", welcome)

	hub.RemoveTrackFromPeers(peer, room)
	hub.ClosePeerConnection(peer)

	if err := hub.CreatePeerConnection(peer, room); err != nil {
		log.Printf("failed to create peer connection for %s: %v", peer.ID, err)
	} else {
		hub.AddTrackToPeers(peer, room)
		if err := hub.SendOffer(peer); err != nil {
			log.Printf("failed to send offer to %s: %v", peer.ID, err)
		}
	}

	hub.BroadcastRoomUpdatePublic(room)
}

func handleMoveToSub(hub *sfu.Hub, peer *sfu.Peer, payload json.RawMessage) {
	var p sfu.MoveToSubPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		peer.SendError(sfu.ErrInvalidMessage, "Invalid move-to-sub payload")
		return
	}

	if p.SubChannelID == "" {
		peer.SendError(sfu.ErrInvalidMessage, "subChannelId is required")
		return
	}

	hub.HandleMoveToSub(peer, p.SubChannelID)
}

func handleAnswer(hub *sfu.Hub, peer *sfu.Peer, payload json.RawMessage) {
	var p sfu.AnswerPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		peer.SendError(sfu.ErrInvalidMessage, "Invalid answer payload")
		return
	}

	if len(p.SDP) > 100_000 {
		log.Printf("SECURITY: oversized_sdp peer=%s size=%d", peer.ID, len(p.SDP))
		peer.SendError(sfu.ErrInvalidMessage, "SDP too large")
		return
	}

	if err := hub.HandleAnswer(peer, p.SDP); err != nil {
		log.Printf("peer %s: handle answer error: %v", peer.ID, err)
	}
}

func handleCandidate(hub *sfu.Hub, peer *sfu.Peer, payload json.RawMessage) {
	var p sfu.CandidatePayload
	if err := json.Unmarshal(payload, &p); err != nil {
		peer.SendError(sfu.ErrInvalidMessage, "Invalid candidate payload")
		return
	}

	if len(p.Candidate) > 2_000 {
		log.Printf("SECURITY: oversized_candidate peer=%s size=%d", peer.ID, len(p.Candidate))
		peer.SendError(sfu.ErrInvalidMessage, "Candidate too large")
		return
	}

	if err := hub.HandleICECandidate(peer, p.Candidate, p.SDPMid, p.SDPMLineIndex); err != nil {
		log.Printf("peer %s: handle candidate error: %v", peer.ID, err)
	}
}

func handleChat(hub *sfu.Hub, peer *sfu.Peer, payload json.RawMessage) {
	var p sfu.ChatPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		peer.SendError(sfu.ErrInvalidMessage, "Invalid chat payload")
		return
	}

	if p.Ciphertext == "" || len(p.Ciphertext) > 10000 {
		return
	}

	hub.HandleChat(peer, p.Ciphertext)
}

func handleMute(hub *sfu.Hub, peer *sfu.Peer, payload json.RawMessage) {
	var p sfu.MutePayload
	if err := json.Unmarshal(payload, &p); err != nil {
		peer.SendError(sfu.ErrInvalidMessage, "Invalid mute payload")
		return
	}

	hub.HandleMute(peer, p.Muted)
}

func handleSubInvite(hub *sfu.Hub, peer *sfu.Peer, payload json.RawMessage) {
	var p sfu.SubInvitePayload
	if err := json.Unmarshal(payload, &p); err != nil {
		peer.SendError(sfu.ErrInvalidMessage, "Invalid sub-invite payload")
		return
	}

	if p.ChannelName != "" && !validateChannelName(p.ChannelName) {
		peer.SendError(sfu.ErrInvalidMessage, "Channel name must be 1-30 alphanumeric characters, spaces, or hyphens")
		return
	}

	hub.HandleSubInvite(peer, p.TargetUserID, p.ChannelName)
}

func handleSubResponse(hub *sfu.Hub, peer *sfu.Peer, payload json.RawMessage) {
	var p sfu.SubResponsePayload
	if err := json.Unmarshal(payload, &p); err != nil {
		peer.SendError(sfu.ErrInvalidMessage, "Invalid sub-response payload")
		return
	}

	hub.HandleSubResponse(peer, p.InviteID, p.Accepted)
}
