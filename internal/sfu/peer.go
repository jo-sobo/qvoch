package sfu

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v3"
)

type Peer struct {
	ID               string
	SessionToken     string
	SessionCreatedAt time.Time
	Name             string
	Conn             *websocket.Conn
	PC               *webrtc.PeerConnection
	Track            *webrtc.TrackLocalStaticRTP
	RoomID           string // Current room (main or sub-channel ID)
	MainRoomID       string // Always the main channel ID
	Muted              bool
	NeedsRenegotiation bool
	mu                 sync.RWMutex
	writeMu            sync.Mutex
}

func (p *Peer) RLock()   { p.mu.RLock() }
func (p *Peer) RUnlock() { p.mu.RUnlock() }
func (p *Peer) Lock()    { p.mu.Lock() }
func (p *Peer) Unlock()  { p.mu.Unlock() }

func (p *Peer) SendJSON(msgType string, payload interface{}) {
	data, err := json.Marshal(payload)
	if err != nil {
		log.Printf("peer %s: marshal error: %v", p.ID, err)
		return
	}

	env := Envelope{
		Type:    msgType,
		Payload: json.RawMessage(data),
	}

	p.writeMu.Lock()
	defer p.writeMu.Unlock()

	if p.Conn == nil {
		return
	}
	if err := p.Conn.WriteJSON(env); err != nil {
		log.Printf("peer %s: write error: %v", p.ID, err)
	}
}

func (p *Peer) SendError(code, message string) {
	p.SendJSON("error", ErrorPayload{Code: code, Message: message})
}

func (p *Peer) WritePing(deadline time.Time) error {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	if p.Conn == nil {
		return nil
	}
	p.Conn.SetWriteDeadline(deadline)
	err := p.Conn.WriteMessage(websocket.PingMessage, nil)
	p.Conn.SetWriteDeadline(time.Time{}) // clear deadline so SendJSON writes aren't affected
	return err
}
