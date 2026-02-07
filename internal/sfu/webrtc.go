package sfu

import (
	"fmt"
	"log"
	"net"
	"os"
	"strconv"

	"github.com/pion/webrtc/v3"
)

type WebRTCConfig struct {
	PublicIP string
	UDPMin   uint16
	UDPMax   uint16
}

func loadWebRTCConfig() WebRTCConfig {
	udpMin := getEnvUint16("UDP_MIN", 40000)
	udpMax := getEnvUint16("UDP_MAX", 40100)
	publicIP := resolvePublicIP(os.Getenv("PUBLIC_IP"))
	return WebRTCConfig{
		PublicIP: publicIP,
		UDPMin:   udpMin,
		UDPMax:   udpMax,
	}
}

func resolvePublicIP(raw string) string {
	if raw == "" {
		return ""
	}
	if ip := net.ParseIP(raw); ip != nil {
		log.Printf("PUBLIC_IP: using %s", raw)
		return raw
	}
	addrs, err := net.LookupHost(raw)
	if err != nil || len(addrs) == 0 {
		log.Printf("WARNING: PUBLIC_IP=%q is not a valid IP and could not be resolved — NAT1To1 disabled", raw)
		return ""
	}
	log.Printf("PUBLIC_IP: resolved %s → %s", raw, addrs[0])
	return addrs[0]
}

func getEnvUint16(key string, defaultVal uint16) uint16 {
	val := os.Getenv(key)
	if val == "" {
		return defaultVal
	}
	n, err := strconv.Atoi(val)
	if err != nil || n < 0 || n > 65535 {
		return defaultVal
	}
	return uint16(n)
}

func NewWebRTCAPI() (*webrtc.API, WebRTCConfig) {
	cfg := loadWebRTCConfig()

	se := webrtc.SettingEngine{}
	se.SetEphemeralUDPPortRange(cfg.UDPMin, cfg.UDPMax)

	if cfg.PublicIP != "" {
		se.SetNAT1To1IPs([]string{cfg.PublicIP}, webrtc.ICECandidateTypeHost)
	}

	me := &webrtc.MediaEngine{}
	if err := me.RegisterDefaultCodecs(); err != nil {
		log.Fatalf("failed to register codecs: %v", err)
	}

	api := webrtc.NewAPI(
		webrtc.WithSettingEngine(se),
		webrtc.WithMediaEngine(me),
	)

	return api, cfg
}

func (h *Hub) CreatePeerConnection(peer *Peer, room *Room) error {
	api := h.getWebRTCAPI()

	config := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
		},
	}

	pc, err := api.NewPeerConnection(config)
	if err != nil {
		return fmt.Errorf("create peer connection: %w", err)
	}

	track, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus},
		fmt.Sprintf("audio-%s", peer.ID),
		fmt.Sprintf("stream-%s", peer.ID),
	)
	if err != nil {
		pc.Close()
		return fmt.Errorf("create track: %w", err)
	}

	peer.Lock()
	peer.PC = pc
	peer.Track = track
	peer.Unlock()

	room.mu.RLock()
	for _, existingPeer := range room.Peers {
		if existingPeer.ID == peer.ID {
			continue
		}
		existingPeer.RLock()
		existingTrack := existingPeer.Track
		existingPeer.RUnlock()

		if existingTrack != nil {
			if _, err := pc.AddTransceiverFromTrack(existingTrack, webrtc.RTPTransceiverInit{
				Direction: webrtc.RTPTransceiverDirectionSendonly,
			}); err != nil {
				log.Printf("failed to add track from %s to %s: %v", existingPeer.ID, peer.ID, err)
			}
		}
	}
	room.mu.RUnlock()

	pc.OnTrack(func(remoteTrack *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		log.Printf("peer %s: OnTrack, codec=%s", peer.ID, remoteTrack.Codec().MimeType)

		go func() {
			buf := make([]byte, 1500)
			for {
				n, _, err := remoteTrack.Read(buf)
				if err != nil {
					return
				}
				peer.RLock()
				t := peer.Track
				peer.RUnlock()
				if t != nil {
					if _, err := t.Write(buf[:n]); err != nil {
						return
					}
				}
			}
		}()
	})

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		candidateJSON := c.ToJSON()
		peer.SendJSON("candidate", CandidatePayload{
			Candidate:     candidateJSON.Candidate,
			SDPMid:        safeString(candidateJSON.SDPMid),
			SDPMLineIndex: safeIntPtr(candidateJSON.SDPMLineIndex),
		})
	})

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("peer %s: connection state: %s", peer.ID, state.String())
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			// Connection lost — handled by WebSocket close
		}
	})

	return nil
}

func (h *Hub) SendOffer(peer *Peer) error {
	peer.RLock()
	pc := peer.PC
	peer.RUnlock()

	if pc == nil {
		return fmt.Errorf("no peer connection")
	}

	_, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionRecvonly,
	})
	if err != nil {
		return fmt.Errorf("add transceiver: %w", err)
	}

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return fmt.Errorf("create offer: %w", err)
	}

	if err := pc.SetLocalDescription(offer); err != nil {
		return fmt.Errorf("set local description: %w", err)
	}

	peer.SendJSON("offer", OfferPayload{SDP: offer.SDP, Reset: true})
	return nil
}

func (h *Hub) HandleAnswer(peer *Peer, sdp string) error {
	peer.RLock()
	pc := peer.PC
	peer.RUnlock()

	if pc == nil {
		return fmt.Errorf("no peer connection")
	}

	answer := webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer,
		SDP:  sdp,
	}

	if err := pc.SetRemoteDescription(answer); err != nil {
		return fmt.Errorf("set remote description: %w", err)
	}

	// Check if a renegotiation was deferred while we were waiting for this answer.
	peer.Lock()
	needsRenego := peer.NeedsRenegotiation
	peer.NeedsRenegotiation = false
	peer.Unlock()

	if needsRenego {
		log.Printf("peer %s: triggering deferred renegotiation", peer.ID)
		go func() {
			if err := h.renegotiate(peer); err != nil {
				log.Printf("peer %s: deferred renegotiation failed: %v", peer.ID, err)
			}
		}()
	}

	return nil
}

func (h *Hub) HandleICECandidate(peer *Peer, candidate string, sdpMid string, sdpMLineIndex *int) error {
	peer.RLock()
	pc := peer.PC
	peer.RUnlock()

	if pc == nil {
		return fmt.Errorf("no peer connection")
	}

	var sdpMLineIndexUint16 *uint16
	if sdpMLineIndex != nil {
		val := uint16(*sdpMLineIndex)
		sdpMLineIndexUint16 = &val
	}

	var sdpMidPtr *string
	if sdpMid != "" {
		sdpMidPtr = &sdpMid
	}

	ice := webrtc.ICECandidateInit{
		Candidate:     candidate,
		SDPMid:        sdpMidPtr,
		SDPMLineIndex: sdpMLineIndexUint16,
	}

	if err := pc.AddICECandidate(ice); err != nil {
		return fmt.Errorf("add ice candidate: %w", err)
	}

	return nil
}

func (h *Hub) AddTrackToPeers(newPeer *Peer, room *Room) {
	newPeer.RLock()
	track := newPeer.Track
	newPeer.RUnlock()

	if track == nil {
		return
	}

	room.mu.RLock()
	peers := make([]*Peer, 0)
	for _, p := range room.Peers {
		if p.ID != newPeer.ID {
			peers = append(peers, p)
		}
	}
	room.mu.RUnlock()

	for _, p := range peers {
		p.RLock()
		pc := p.PC
		p.RUnlock()

		if pc == nil {
			continue
		}

		if _, err := pc.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{
			Direction: webrtc.RTPTransceiverDirectionSendonly,
		}); err != nil {
			log.Printf("failed to add track from %s to %s: %v", newPeer.ID, p.ID, err)
			continue
		}

		if err := h.renegotiate(p); err != nil {
			log.Printf("failed to renegotiate with %s: %v", p.ID, err)
		}
	}
}

func (h *Hub) RemoveTrackFromPeers(leavingPeer *Peer, room *Room) {
	leavingPeer.RLock()
	track := leavingPeer.Track
	leavingPeer.RUnlock()

	if track == nil {
		return
	}

	room.mu.RLock()
	peers := make([]*Peer, 0)
	for _, p := range room.Peers {
		if p.ID != leavingPeer.ID {
			peers = append(peers, p)
		}
	}
	room.mu.RUnlock()

	for _, p := range peers {
		p.RLock()
		pc := p.PC
		p.RUnlock()

		if pc == nil {
			continue
		}

		for _, sender := range pc.GetSenders() {
			if sender.Track() == track {
				if err := pc.RemoveTrack(sender); err != nil {
					log.Printf("failed to remove track from %s: %v", p.ID, err)
				}
				break
			}
		}

		if err := h.renegotiate(p); err != nil {
			log.Printf("failed to renegotiate with %s after track removal: %v", p.ID, err)
		}
	}
}

func (h *Hub) ClosePeerConnection(peer *Peer) {
	peer.Lock()
	pc := peer.PC
	peer.PC = nil
	peer.Track = nil
	peer.Unlock()

	if pc != nil {
		pc.Close()
	}
}

func (h *Hub) renegotiate(peer *Peer) error {
	peer.RLock()
	pc := peer.PC
	peer.RUnlock()

	if pc == nil {
		return fmt.Errorf("no peer connection")
	}

	// Only renegotiate when the PC is in a stable state.
	// If we're still waiting for an answer to a previous offer, mark for retry.
	if pc.SignalingState() != webrtc.SignalingStateStable {
		log.Printf("peer %s: deferring renegotiation, signaling state is %s", peer.ID, pc.SignalingState().String())
		peer.Lock()
		peer.NeedsRenegotiation = true
		peer.Unlock()
		return nil
	}

	peer.Lock()
	peer.NeedsRenegotiation = false
	peer.Unlock()

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return fmt.Errorf("create offer: %w", err)
	}

	if err := pc.SetLocalDescription(offer); err != nil {
		return fmt.Errorf("set local description: %w", err)
	}

	peer.SendJSON("offer", OfferPayload{SDP: offer.SDP})
	return nil
}

// removeTrackFromRoomPeers removes a specific track from all PeerConnections in the room
// and renegotiates affected peers. Used when the track owner's PC has already been closed
// (so RemoveTrackFromPeers can't read the track from the peer).
func (h *Hub) removeTrackFromRoomPeers(track *webrtc.TrackLocalStaticRTP, room *Room) {
	if track == nil {
		return
	}

	room.mu.RLock()
	peers := make([]*Peer, 0, len(room.Peers))
	for _, p := range room.Peers {
		peers = append(peers, p)
	}
	room.mu.RUnlock()

	for _, p := range peers {
		p.RLock()
		pc := p.PC
		p.RUnlock()
		if pc == nil {
			continue
		}

		for _, sender := range pc.GetSenders() {
			if sender.Track() == track {
				if err := pc.RemoveTrack(sender); err != nil {
					log.Printf("failed to remove track from %s: %v", p.ID, err)
				}
				break
			}
		}

		if err := h.renegotiate(p); err != nil {
			log.Printf("failed to renegotiate with %s: %v", p.ID, err)
		}
	}
}

func (h *Hub) getWebRTCAPI() *webrtc.API {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.webrtcAPI == nil {
		api, _ := NewWebRTCAPI()
		h.webrtcAPI = api
	}
	return h.webrtcAPI
}

func safeString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func safeIntPtr(p *uint16) *int {
	if p == nil {
		return nil
	}
	v := int(*p)
	return &v
}
