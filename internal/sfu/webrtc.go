package sfu

import (
	"fmt"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/pion/rtp"
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

func loadWebRTCConfigQuiet() WebRTCConfig {
	udpMin := getEnvUint16("UDP_MIN", 40000)
	udpMax := getEnvUint16("UDP_MAX", 40100)
	publicIP := resolvePublicIPQuiet(os.Getenv("PUBLIC_IP"))
	return WebRTCConfig{
		PublicIP: publicIP,
		UDPMin:   udpMin,
		UDPMax:   udpMax,
	}
}

func resolvePublicIP(raw string) string {
	return resolvePublicIPInternal(raw, true)
}

func resolvePublicIPQuiet(raw string) string {
	return resolvePublicIPInternal(raw, false)
}

func resolvePublicIPInternal(raw string, verbose bool) string {
	if raw == "" {
		return ""
	}
	if ip := net.ParseIP(raw); ip != nil {
		if verbose {
			log.Printf("PUBLIC_IP: using %s", raw)
		}
		return raw
	}
	ips, err := net.LookupIP(raw)
	if err != nil || len(ips) == 0 {
		if verbose {
			log.Printf("WARNING: PUBLIC_IP=%q is not a valid IP and could not be resolved — NAT1To1 disabled", raw)
		}
		return ""
	}

	// Prefer IPv4 so candidate advertisement matches common home-router UDP
	// forwarding setups when a hostname resolves to both A and AAAA records.
	for _, ip := range ips {
		if ipv4 := ip.To4(); ipv4 != nil {
			resolved := ipv4.String()
			if verbose {
				log.Printf("PUBLIC_IP: resolved %s → %s (preferred IPv4)", raw, resolved)
			}
			return resolved
		}
	}

	resolved := ips[0].String()
	if verbose {
		log.Printf("PUBLIC_IP: resolved %s → %s", raw, resolved)
	}
	return resolved
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

func getEnvDuration(key string, defaultVal time.Duration) time.Duration {
	val := strings.TrimSpace(os.Getenv(key))
	if val == "" {
		return defaultVal
	}

	if d, err := time.ParseDuration(val); err == nil {
		return d
	}

	if n, err := strconv.Atoi(val); err == nil && n >= 0 {
		return time.Duration(n) * time.Second
	}

	return defaultVal
}

func getEnvBool(key string, defaultVal bool) bool {
	val := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	if val == "" {
		return defaultVal
	}
	switch val {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return defaultVal
	}
}

func NewWebRTCAPI() (*webrtc.API, WebRTCConfig) {
	cfg := loadWebRTCConfig()
	return buildWebRTCAPI(cfg), cfg
}

func buildWebRTCAPI(cfg WebRTCConfig) *webrtc.API {
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

	return api
}

func (h *Hub) CreatePeerConnection(peer *Peer, room *Room) error {
	api := h.getWebRTCAPI()
	_ = room

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

	peer.negoMu.Lock()
	peer.Lock()
	if peer.signalingReady != nil {
		close(peer.signalingReady)
		peer.signalingReady = nil
	}
	peer.PC = pc
	peer.Track = track
	peer.Epoch++
	peer.OfferSeq = 0
	peer.pendingRenego = false
	peer.iceRestartQueued = false
	peer.Unlock()
	peer.negoMu.Unlock()

	pc.OnTrack(func(remoteTrack *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		log.Printf("peer %s: OnTrack, codec=%s", peer.ID, remoteTrack.Codec().MimeType)

		go func() {
			buf := make([]byte, 1500)
			rtpPkt := &rtp.Packet{}
			lastStatsLog := time.Now()
			var rxPackets uint64
			var forwardedPackets uint64
			var forwardErrors uint64
			for {
				n, _, err := remoteTrack.Read(buf)
				if err != nil {
					return
				}
				rxPackets++

				if err := rtpPkt.Unmarshal(buf[:n]); err != nil {
					log.Printf("peer %s: failed to unmarshal RTP packet: %v", peer.ID, err)
					continue
				}

				// Cross-browser peers may negotiate different RTP header extension IDs
				// (e.g. Firefox vs Chrome). Forwarding extensions untouched can break
				// decode on receivers, so strip them before re-writing.
				rtpPkt.Extension = false
				rtpPkt.Extensions = nil

				peer.RLock()
				t := peer.Track
				peer.RUnlock()
				if t != nil {
					if err := t.WriteRTP(rtpPkt); err != nil {
						// TrackLocalStaticRTP may return aggregated write errors for one
						// binding while still delivering to others. Don't stop forwarding.
						log.Printf("peer %s: forward write error: %v", peer.ID, err)
						forwardErrors++
					} else {
						forwardedPackets++
					}
				}

				if time.Since(lastStatsLog) >= 5*time.Second {
					log.Printf("peer %s: RTP stats rx=%d forwarded=%d forwardErrors=%d",
						peer.ID, rxPackets, forwardedPackets, forwardErrors)
					lastStatsLog = time.Now()
				}
			}
		}()
	})

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		candidateJSON := c.ToJSON()
		peer.RLock()
		seq := peer.OfferSeq
		epoch := peer.Epoch
		peer.RUnlock()
		peer.SendJSON("candidate", CandidatePayload{
			Candidate:     candidateJSON.Candidate,
			SDPMid:        safeString(candidateJSON.SDPMid),
			SDPMLineIndex: safeIntPtr(candidateJSON.SDPMLineIndex),
			Seq:           seq,
			Epoch:         epoch,
		})
	})

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("peer %s: connection state: %s", peer.ID, state.String())
		switch state {
		case webrtc.PeerConnectionStateConnected:
			peer.Lock()
			peer.iceRestartQueued = false
			peer.Unlock()
		case webrtc.PeerConnectionStateDisconnected:
			h.queueICERestart(peer, 3*time.Second)
		case webrtc.PeerConnectionStateFailed:
			h.queueICERestart(peer, 0)
		}
	})

	return nil
}

func (h *Hub) queueICERestart(peer *Peer, delay time.Duration) {
	peer.Lock()
	if peer.iceRestartQueued {
		peer.Unlock()
		return
	}
	peer.iceRestartQueued = true
	peer.Unlock()

	if delay <= 0 {
		go h.attemptICERestart(peer)
		return
	}

	time.AfterFunc(delay, func() {
		h.attemptICERestart(peer)
	})
}

func (h *Hub) attemptICERestart(peer *Peer) {
	peer.negoMu.Lock()

	peer.RLock()
	pc := peer.PC
	peer.RUnlock()

	if pc == nil {
		peer.Lock()
		peer.iceRestartQueued = false
		peer.Unlock()
		peer.negoMu.Unlock()
		return
	}

	state := pc.ConnectionState()
	if state == webrtc.PeerConnectionStateConnected || state == webrtc.PeerConnectionStateClosed {
		peer.Lock()
		peer.iceRestartQueued = false
		peer.Unlock()
		peer.negoMu.Unlock()
		return
	}

	log.Printf("peer %s: attempting ICE restart, connectionState=%s", peer.ID, state.String())

	offer, err := pc.CreateOffer(&webrtc.OfferOptions{ICERestart: true})
	if err != nil {
		log.Printf("peer %s: ICE restart offer failed: %v", peer.ID, err)
		peer.Lock()
		peer.iceRestartQueued = false
		peer.Unlock()
		peer.negoMu.Unlock()
		return
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		log.Printf("peer %s: ICE restart set local description failed: %v", peer.ID, err)
		peer.Lock()
		peer.iceRestartQueued = false
		peer.Unlock()
		peer.negoMu.Unlock()
		return
	}

	peer.Lock()
	peer.OfferSeq++
	seq := peer.OfferSeq
	epoch := peer.Epoch
	peer.pendingRenego = false
	peer.iceRestartQueued = false
	if peer.signalingReady != nil {
		close(peer.signalingReady)
	}
	sr := make(chan struct{})
	peer.signalingReady = sr
	peer.Unlock()

	peer.SendJSON("offer", OfferPayload{
		SDP:   offer.SDP,
		Seq:   seq,
		Epoch: epoch,
	})

	peer.negoMu.Unlock()

	select {
	case <-sr:
		log.Printf("peer %s: ICE restart completed", peer.ID)
	case <-time.After(10 * time.Second):
		log.Printf("peer %s: ICE restart answer timeout", peer.ID)
	}
}

func (h *Hub) NegotiateOffer(peer *Peer, isInitial bool) error {
	return h.negotiateOffer(peer, isInitial)
}

func (h *Hub) negotiateOffer(peer *Peer, isInitial bool) error {
	for {
		peer.negoMu.Lock()

		peer.RLock()
		pc := peer.PC
		epoch := peer.Epoch
		peer.RUnlock()

		if pc == nil {
			peer.negoMu.Unlock()
			return fmt.Errorf("no peer connection")
		}

		if isInitial {
			if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{
				Direction: webrtc.RTPTransceiverDirectionRecvonly,
			}); err != nil {
				peer.negoMu.Unlock()
				return fmt.Errorf("add transceiver: %w", err)
			}
			isInitial = false
		}

		if pc.SignalingState() != webrtc.SignalingStateStable {
			log.Printf("peer %s: deferring renegotiation, signaling state is %s", peer.ID, pc.SignalingState().String())
			peer.Lock()
			peer.pendingRenego = true
			peer.Unlock()
			peer.negoMu.Unlock()
			return nil
		}

		peer.Lock()
		peer.OfferSeq++
		seq := peer.OfferSeq
		peer.pendingRenego = false
		if peer.signalingReady != nil {
			close(peer.signalingReady)
		}
		sr := make(chan struct{})
		peer.signalingReady = sr
		peer.Unlock()

		offer, err := pc.CreateOffer(nil)
		if err != nil {
			peer.negoMu.Unlock()
			return fmt.Errorf("create offer: %w", err)
		}
		if err := pc.SetLocalDescription(offer); err != nil {
			peer.negoMu.Unlock()
			return fmt.Errorf("set local description: %w", err)
		}

		log.Printf("peer %s: offer seq=%d epoch=%d initial=%t signalingState=%s transceivers=%s",
			peer.ID, seq, epoch, seq == 1, pc.SignalingState().String(), summarizeTransceivers(pc))
		peer.SendJSON("offer", OfferPayload{
			SDP:   offer.SDP,
			Reset: seq == 1,
			Seq:   seq,
			Epoch: epoch,
		})

		peer.negoMu.Unlock()

		select {
		case <-sr:
		case <-time.After(10 * time.Second):
			log.Printf("peer %s: answer timeout seq=%d epoch=%d", peer.ID, seq, epoch)
			return nil
		}

		peer.Lock()
		needsRenego := peer.pendingRenego
		peer.pendingRenego = false
		peer.Unlock()

		if !needsRenego {
			return nil
		}
		log.Printf("peer %s: processing deferred renegotiation", peer.ID)
	}
}

func (h *Hub) HandleAnswer(peer *Peer, sdp string, seq uint64, epoch uint64) error {
	peer.RLock()
	pc := peer.PC
	currentEpoch := peer.Epoch
	currentSeq := peer.OfferSeq
	peer.RUnlock()

	if pc == nil {
		return fmt.Errorf("no peer connection")
	}
	if epoch != currentEpoch {
		log.Printf("peer %s: discarding stale answer epoch=%d (current=%d)", peer.ID, epoch, currentEpoch)
		return nil
	}
	if seq != currentSeq {
		log.Printf("peer %s: discarding stale answer seq=%d (current=%d)", peer.ID, seq, currentSeq)
		return nil
	}

	answer := webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp}
	if err := pc.SetRemoteDescription(answer); err != nil {
		return fmt.Errorf("set remote description: %w", err)
	}

	log.Printf("peer %s: answer received seq=%d epoch=%d transceivers=%s",
		peer.ID, seq, epoch, summarizeTransceivers(pc))

	peer.Lock()
	if peer.signalingReady != nil {
		close(peer.signalingReady)
		peer.signalingReady = nil
	}
	peer.Unlock()

	return nil
}

func (h *Hub) HandleICECandidate(peer *Peer, candidate string, sdpMid string, sdpMLineIndex *int, seq uint64, epoch uint64) error {
	peer.RLock()
	pc := peer.PC
	currentEpoch := peer.Epoch
	currentSeq := peer.OfferSeq
	peer.RUnlock()

	if pc == nil {
		return fmt.Errorf("no peer connection")
	}
	if epoch != currentEpoch {
		log.Printf("peer %s: discarding stale ICE candidate epoch=%d (current=%d)", peer.ID, epoch, currentEpoch)
		return nil
	}
	if seq > currentSeq {
		log.Printf("peer %s: discarding future ICE candidate seq=%d (current=%d)", peer.ID, seq, currentSeq)
		return nil
	}
	if seq < currentSeq {
		log.Printf("peer %s: accepting late ICE candidate seq=%d (current=%d)", peer.ID, seq, currentSeq)
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

	needsRenego := make([]*Peer, 0, len(peers))
	for _, p := range peers {
		p.RLock()
		pc := p.PC
		p.RUnlock()

		if pc == nil {
			continue
		}
		if hasSenderForTrack(pc, track) {
			continue
		}

		transceiver, err := pc.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{
			Direction: webrtc.RTPTransceiverDirectionSendonly,
		})
		if err != nil {
			log.Printf("failed to add track from %s to %s: %v", newPeer.ID, p.ID, err)
			continue
		}
		if transceiver != nil && transceiver.Sender() != nil {
			h.drainSenderRTCP(transceiver.Sender())
		}
		log.Printf("peer %s: attached outbound track from %s", p.ID, newPeer.ID)

		needsRenego = append(needsRenego, p)
	}

	for _, p := range needsRenego {
		go func(target *Peer) {
			if err := h.NegotiateOffer(target, false); err != nil {
				log.Printf("failed to renegotiate with %s: %v", target.ID, err)
			}
		}(p)
	}
}

// AddRoomTracksToPeer ensures the target peer has senders for all other peers'
// tracks in the room. It only mutates transceivers and does not renegotiate.
func (h *Hub) AddRoomTracksToPeer(targetPeer *Peer, room *Room) bool {
	targetPeer.RLock()
	targetPC := targetPeer.PC
	targetPeerID := targetPeer.ID
	targetPeer.RUnlock()

	if targetPC == nil {
		return false
	}

	room.mu.RLock()
	peers := make([]*Peer, 0, len(room.Peers))
	for _, p := range room.Peers {
		if p.ID != targetPeerID {
			peers = append(peers, p)
		}
	}
	room.mu.RUnlock()

	addedAny := false
	addedCount := 0
	for _, p := range peers {
		p.RLock()
		track := p.Track
		p.RUnlock()
		if track == nil {
			continue
		}
		if hasSenderForTrack(targetPC, track) {
			continue
		}

		transceiver, err := targetPC.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{
			Direction: webrtc.RTPTransceiverDirectionSendonly,
		})
		if err != nil {
			log.Printf("failed to add room track from %s to %s: %v", p.ID, targetPeerID, err)
			continue
		}
		if transceiver != nil && transceiver.Sender() != nil {
			h.drainSenderRTCP(transceiver.Sender())
		}
		addedAny = true
		addedCount++
		log.Printf("peer %s: attached existing track from %s", targetPeerID, p.ID)
	}

	if addedAny {
		log.Printf("peer %s: added %d existing room tracks", targetPeerID, addedCount)
	}

	return addedAny
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

	needsRenego := make([]*Peer, 0, len(peers))
	for _, p := range peers {
		p.RLock()
		pc := p.PC
		p.RUnlock()

		if pc == nil {
			continue
		}

		removed := false
		for _, sender := range pc.GetSenders() {
			if sender.Track() == track {
				if err := pc.RemoveTrack(sender); err != nil {
					log.Printf("failed to remove track from %s: %v", p.ID, err)
					continue
				}
				removed = true
			}
		}

		if removed {
			needsRenego = append(needsRenego, p)
		}
	}

	for _, p := range needsRenego {
		go func(target *Peer) {
			if err := h.NegotiateOffer(target, false); err != nil {
				log.Printf("failed to renegotiate with %s after track removal: %v", target.ID, err)
			}
		}(p)
	}
}

func (h *Hub) ClosePeerConnection(peer *Peer) {
	peer.negoMu.Lock()
	peer.Lock()
	pc := peer.PC
	peer.PC = nil
	peer.Track = nil
	peer.OfferSeq = 0
	peer.pendingRenego = false
	peer.iceRestartQueued = false
	if peer.signalingReady != nil {
		close(peer.signalingReady)
		peer.signalingReady = nil
	}
	peer.Unlock()
	peer.negoMu.Unlock()

	if pc != nil {
		pc.Close()
	}
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

	needsRenego := make([]*Peer, 0, len(peers))
	for _, p := range peers {
		p.RLock()
		pc := p.PC
		p.RUnlock()
		if pc == nil {
			continue
		}

		removed := false
		for _, sender := range pc.GetSenders() {
			if sender.Track() == track {
				if err := pc.RemoveTrack(sender); err != nil {
					log.Printf("failed to remove track from %s: %v", p.ID, err)
					continue
				}
				removed = true
			}
		}

		if removed {
			needsRenego = append(needsRenego, p)
		}
	}

	for _, p := range needsRenego {
		go func(target *Peer) {
			if err := h.NegotiateOffer(target, false); err != nil {
				log.Printf("failed to renegotiate with %s: %v", target.ID, err)
			}
		}(p)
	}
}

func (h *Hub) getWebRTCAPI() *webrtc.API {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.webrtcAPI == nil {
		api, cfg := NewWebRTCAPI()
		h.webrtcAPI = api
		h.webrtcCfg = cfg
	}
	return h.webrtcAPI
}

func (h *Hub) startPublicIPMonitor() {
	source := strings.TrimSpace(os.Getenv("PUBLIC_IP"))
	if source == "" {
		return
	}

	interval := getEnvDuration("PUBLIC_IP_RECHECK_INTERVAL", 0)
	if interval <= 0 {
		return
	}
	rebuildPeers := getEnvBool("PUBLIC_IP_RECHECK_REBUILD_PEERS", true)

	log.Printf("PUBLIC_IP monitor enabled: source=%s interval=%s rebuildPeers=%t", source, interval, rebuildPeers)

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for range ticker.C {
		nextCfg := loadWebRTCConfigQuiet()

		h.mu.RLock()
		currentCfg := h.webrtcCfg
		apiInitialized := h.webrtcAPI != nil
		h.mu.RUnlock()

		if !apiInitialized {
			continue
		}

		if nextCfg.PublicIP == "" && currentCfg.PublicIP != "" {
			log.Printf("PUBLIC_IP monitor: resolution temporarily failed, keeping previous IP %s", currentCfg.PublicIP)
			continue
		}

		if nextCfg.PublicIP == currentCfg.PublicIP &&
			nextCfg.UDPMin == currentCfg.UDPMin &&
			nextCfg.UDPMax == currentCfg.UDPMax {
			continue
		}

		h.applyWebRTCConfig(nextCfg, rebuildPeers)
	}
}

func (h *Hub) applyWebRTCConfig(cfg WebRTCConfig, rebuildPeers bool) {
	api := buildWebRTCAPI(cfg)

	var targets []rebuildEntry
	h.mu.Lock()
	prevCfg := h.webrtcCfg
	h.webrtcAPI = api
	h.webrtcCfg = cfg
	mainRooms := make([]*Room, 0, len(h.Rooms))
	for _, room := range h.Rooms {
		if room.ParentID == "" {
			mainRooms = append(mainRooms, room)
		}
	}
	h.mu.Unlock()

	log.Printf("WebRTC config updated: PUBLIC_IP %s -> %s, UDP range %d-%d -> %d-%d",
		prevCfg.PublicIP, cfg.PublicIP, prevCfg.UDPMin, prevCfg.UDPMax, cfg.UDPMin, cfg.UDPMax)

	if !rebuildPeers {
		return
	}

	targets = collectRebuildTargets(mainRooms)
	if len(targets) == 0 {
		return
	}

	log.Printf("Rebuilding %d peer connections to apply updated WebRTC config", len(targets))
	for _, target := range targets {
		h.rebuildPeerConnection(target.peer, target.room)
	}
}

func collectRebuildTargets(mainRooms []*Room) []rebuildEntry {
	targets := make([]rebuildEntry, 0)

	for _, mainRoom := range mainRooms {
		mainRoom.mu.RLock()

		for _, peer := range mainRoom.Peers {
			peer.RLock()
			hasPC := peer.PC != nil
			peer.RUnlock()
			if hasPC {
				targets = append(targets, rebuildEntry{peer: peer, room: mainRoom})
			}
		}

		for _, subRoom := range mainRoom.SubChannels {
			subRoom.mu.RLock()
			for _, peer := range subRoom.Peers {
				peer.RLock()
				hasPC := peer.PC != nil
				peer.RUnlock()
				if hasPC {
					targets = append(targets, rebuildEntry{peer: peer, room: subRoom})
				}
			}
			subRoom.mu.RUnlock()
		}

		mainRoom.mu.RUnlock()
	}

	return targets
}

func (h *Hub) rebuildPeerConnection(peer *Peer, room *Room) {
	room.mu.RLock()
	_, stillInRoom := room.Peers[peer.ID]
	room.mu.RUnlock()
	if !stillInRoom {
		return
	}

	h.RemoveTrackFromPeers(peer, room)
	h.ClosePeerConnection(peer)

	if err := h.CreatePeerConnection(peer, room); err != nil {
		log.Printf("failed to rebuild peer connection for %s: %v", peer.ID, err)
		return
	}

	h.AddTrackToPeers(peer, room)
	go func(target *Peer, targetRoom *Room) {
		if err := h.NegotiateOffer(target, true); err != nil {
			log.Printf("failed to send rebuilt initial offer to %s: %v", target.ID, err)
			return
		}
		if h.AddRoomTracksToPeer(target, targetRoom) {
			if err := h.NegotiateOffer(target, false); err != nil {
				log.Printf("failed to send rebuilt room-track offer to %s: %v", target.ID, err)
			}
		}
	}(peer, room)
}

func (h *Hub) drainSenderRTCP(sender *webrtc.RTPSender) {
	go func() {
		rtcpBuf := make([]byte, 1500)
		for {
			if _, _, err := sender.Read(rtcpBuf); err != nil {
				return
			}
		}
	}()
}

func hasSenderForTrack(pc *webrtc.PeerConnection, track *webrtc.TrackLocalStaticRTP) bool {
	for _, sender := range pc.GetSenders() {
		if sender.Track() == track {
			return true
		}
	}
	return false
}

func summarizeTransceivers(pc *webrtc.PeerConnection) string {
	total := 0
	sendonly := 0
	recvonly := 0
	sendrecv := 0
	inactive := 0

	for _, tr := range pc.GetTransceivers() {
		total++
		switch tr.Direction() {
		case webrtc.RTPTransceiverDirectionSendonly:
			sendonly++
		case webrtc.RTPTransceiverDirectionRecvonly:
			recvonly++
		case webrtc.RTPTransceiverDirectionSendrecv:
			sendrecv++
		case webrtc.RTPTransceiverDirectionInactive:
			inactive++
		}
	}

	return strings.TrimSpace(fmt.Sprintf("total=%d sendonly=%d recvonly=%d sendrecv=%d inactive=%d",
		total, sendonly, recvonly, sendrecv, inactive))
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
