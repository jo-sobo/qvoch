package sfu

import (
	"fmt"
	"log"
	"math/rand"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pion/webrtc/v3"
	"golang.org/x/crypto/bcrypt"
)

type PendingInvite struct {
	ID          string
	FromPeer    *Peer
	ToPeer      *Peer
	MainRoom    *Room
	ChannelName string
	Timer       *time.Timer
	CreatedAt   time.Time
}

type Hub struct {
	Rooms          map[string]*Room
	RoomsByName    map[string]*Room
	InviteMap      map[string]*Room
	SessionMap     map[string]*Peer
	PendingInvites map[string]*PendingInvite
	mu             sync.RWMutex

	webrtcAPI        *webrtc.API
	maxUsersPerRoom  int
	maxTotalRooms    int
	chatHistorySize  int
	roomCreatesPerIP map[string][]time.Time
}

var hub *Hub
var hubOnce sync.Once

func GetHub() *Hub {
	hubOnce.Do(func() {
		maxUsers := getEnvIntBounded("MAX_USERS_PER_ROOM", 25, 1, 100)
		maxRooms := getEnvIntBounded("MAX_ROOMS", 100, 1, 10000)
		chatSize := getEnvIntBounded("CHAT_HISTORY_SIZE", 200, 10, 1000)

		hub = &Hub{
			Rooms:            make(map[string]*Room),
			RoomsByName:      make(map[string]*Room),
			InviteMap:        make(map[string]*Room),
			SessionMap:       make(map[string]*Peer),
			PendingInvites:   make(map[string]*PendingInvite),
			maxUsersPerRoom:  maxUsers,
			maxTotalRooms:    maxRooms,
			chatHistorySize:  chatSize,
			roomCreatesPerIP: make(map[string][]time.Time),
		}

		log.Printf("Hub: maxUsersPerRoom=%d maxRooms=%d chatHistorySize=%d", maxUsers, maxRooms, chatSize)
		go hub.startGC()
	})
	return hub
}

func getEnvInt(key string, defaultVal int) int {
	val := os.Getenv(key)
	if val == "" {
		return defaultVal
	}
	n, err := strconv.Atoi(val)
	if err != nil {
		return defaultVal
	}
	return n
}

func getEnvIntBounded(key string, defaultVal, minVal, maxVal int) int {
	n := getEnvInt(key, defaultVal)
	if n < minVal {
		return minVal
	}
	if n > maxVal {
		return maxVal
	}
	return n
}

func generateRoomSuffix() string {
	return fmt.Sprintf("#%04d", rand.Intn(10000))
}

func (h *Hub) CreateRoom(channelName, password string, creator *Peer, ip string) (*Room, error) {
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("hash password: %w", err)
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	if len(h.Rooms) >= h.maxTotalRooms {
		return nil, fmt.Errorf("%s:Server has reached the maximum number of rooms", ErrServerFull)
	}

	if ip != "" {
		now := time.Now()
		cutoff := now.Add(-10 * time.Minute)
		recent := h.roomCreatesPerIP[ip]
		filtered := recent[:0]
		for _, t := range recent {
			if t.After(cutoff) {
				filtered = append(filtered, t)
			}
		}
		h.roomCreatesPerIP[ip] = filtered
		if len(filtered) >= 3 {
			return nil, fmt.Errorf("%s:Too many rooms created recently, try again later", ErrServerFull)
		}
		h.roomCreatesPerIP[ip] = append(h.roomCreatesPerIP[ip], now)
	}

	var fullName string
	for i := 0; i < 10; i++ {
		fullName = channelName + generateRoomSuffix()
		if _, exists := h.RoomsByName[fullName]; !exists {
			break
		}
		if i == 9 {
			return nil, fmt.Errorf("could not generate unique room name after 10 retries")
		}
	}

	roomID := uuid.New().String()
	inviteToken := uuid.New().String()

	room := NewRoom(roomID, channelName, fullName, inviteToken, string(hashedPassword))

	creator.mu.Lock()
	creator.RoomID = roomID
	creator.MainRoomID = roomID
	creator.mu.Unlock()

	room.AddPeer(creator)

	h.Rooms[roomID] = room
	h.RoomsByName[fullName] = room
	h.InviteMap[inviteToken] = room

	sessionToken := uuid.New().String()
	creator.mu.Lock()
	creator.SessionToken = sessionToken
	creator.SessionCreatedAt = time.Now()
	creator.mu.Unlock()
	h.SessionMap[sessionToken] = creator

	log.Printf("room created: %s (ID: %s)", fullName, roomID)
	return room, nil
}

func (h *Hub) JoinRoom(payload JoinPayload, peer *Peer) (*Room, string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if payload.SessionToken != "" {
		existingPeer, ok := h.SessionMap[payload.SessionToken]
		if ok {
			existingPeer.mu.RLock()
			sessionAge := time.Since(existingPeer.SessionCreatedAt)
			existingPeer.mu.RUnlock()
			if sessionAge > 24*time.Hour {
				delete(h.SessionMap, payload.SessionToken)
				ok = false
			}
		}
		if ok {
			roomID := existingPeer.RoomID
			mainRoomID := existingPeer.MainRoomID
			room, roomOk := h.Rooms[roomID]
			if !roomOk {
				room = h.Rooms[mainRoomID]
			}
			if room != nil {
				// Replace the connection on the existing peer
				existingPeer.Lock()
				existingPeer.Conn = peer.Conn
				existingPeer.Unlock()

				peer.Lock()
				peer.ID = existingPeer.ID
				peer.Name = existingPeer.Name
				peer.SessionToken = existingPeer.SessionToken
				peer.RoomID = existingPeer.RoomID
				peer.MainRoomID = existingPeer.MainRoomID
				peer.Muted = existingPeer.Muted
				peer.PC = existingPeer.PC
				peer.Track = existingPeer.Track
				peer.Unlock()

				existingPeer.Lock()
				existingPeer.PC = nil
				existingPeer.Track = nil
				existingPeer.Unlock()

				log.Printf("peer %s reconnected via session token", existingPeer.ID)
				return room, payload.SessionToken, nil
			}
		}
	}

	var room *Room

	if payload.InviteToken != "" {
		r, ok := h.InviteMap[payload.InviteToken]
		if !ok {
			return nil, "", fmt.Errorf("%s:Room not found", ErrChannelNotFound)
		}
		if time.Since(r.CreatedAt) > 7*24*time.Hour {
			delete(h.InviteMap, payload.InviteToken)
			return nil, "", fmt.Errorf("%s:Invite link has expired", ErrInviteExpired)
		}
		room = r
	} else if payload.ChannelName != "" {
		r, ok := h.RoomsByName[payload.ChannelName]
		if !ok {
			return nil, "", fmt.Errorf("%s:Room not found", ErrChannelNotFound)
		}
		room = r

		if payload.Password == "" {
			return nil, "", fmt.Errorf("%s:Password is required", ErrPasswordRequired)
		}
		if err := bcrypt.CompareHashAndPassword([]byte(room.PasswordHash), []byte(payload.Password)); err != nil {
			return nil, "", fmt.Errorf("%s:Invalid password", ErrPasswordWrong)
		}
	} else {
		return nil, "", fmt.Errorf("%s:Must provide channelName or inviteToken", ErrInvalidMessage)
	}

	room.mu.Lock()
	defer room.mu.Unlock()

	targetRoom := room
	if room.ParentID != "" {
		return nil, "", fmt.Errorf("%s:Cannot join sub-channel directly", ErrInvalidMessage)
	}

	totalPeers := len(targetRoom.Peers)
	for _, sub := range targetRoom.SubChannels {
		sub.mu.RLock()
		totalPeers += len(sub.Peers)
		sub.mu.RUnlock()
	}
	if totalPeers >= h.maxUsersPerRoom {
		return nil, "", fmt.Errorf("%s:Room is full", ErrChannelFull)
	}

	if h.isNameTakenInRoom(targetRoom, payload.Username) {
		return nil, "", fmt.Errorf("%s:Username already taken in this room", ErrNameTaken)
	}

	peer.mu.Lock()
	peer.Name = payload.Username
	peer.RoomID = targetRoom.ID
	peer.MainRoomID = targetRoom.ID
	peer.mu.Unlock()

	targetRoom.AddPeer(peer)

	sessionToken := uuid.New().String()
	peer.mu.Lock()
	peer.SessionToken = sessionToken
	peer.SessionCreatedAt = time.Now()
	peer.mu.Unlock()
	h.SessionMap[sessionToken] = peer

	log.Printf("peer %s (%s) joined room %s", peer.Name, peer.ID, targetRoom.FullName)
	return targetRoom, sessionToken, nil
}

func (h *Hub) isNameTakenInRoom(room *Room, username string) bool {
	for _, p := range room.Peers {
		p.mu.RLock()
		name := p.Name
		p.mu.RUnlock()
		if name == username {
			return true
		}
	}
	for _, sub := range room.SubChannels {
		sub.mu.RLock()
		for _, p := range sub.Peers {
			p.mu.RLock()
			name := p.Name
			p.mu.RUnlock()
			if name == username {
				sub.mu.RUnlock()
				return true
			}
		}
		sub.mu.RUnlock()
	}
	return false
}

func (h *Hub) RemovePeer(peer *Peer) {
	peer.mu.RLock()
	roomID := peer.RoomID
	mainRoomID := peer.MainRoomID
	sessionToken := peer.SessionToken
	peer.mu.RUnlock()

	if roomID == "" {
		return
	}

	var currentRoom *Room
	h.mu.Lock()
	delete(h.SessionMap, sessionToken)

	room, ok := h.Rooms[roomID]
	if !ok {
		mainRoom, mok := h.Rooms[mainRoomID]
		if mok {
			mainRoom.mu.Lock()
			if sub, sok := mainRoom.SubChannels[roomID]; sok {
				currentRoom = sub
				sub.mu.Lock()
				sub.RemovePeer(peer.ID)
				sub.mu.Unlock()
			}
			mainRoom.mu.Unlock()
		}
		h.mu.Unlock()

		if currentRoom != nil {
			h.RemoveTrackFromPeers(peer, currentRoom)
		}
		h.ClosePeerConnection(peer)

		if currentRoom != nil {
			h.sendSubCountdownIfNeeded(currentRoom)

			// Immediately clean up empty sub-channels
			if mok {
				mainRoom.mu.Lock()
				currentRoom.mu.RLock()
				subEmpty := len(currentRoom.Peers) == 0
				subID := currentRoom.ID
				currentRoom.mu.RUnlock()
				if subEmpty {
					delete(mainRoom.SubChannels, subID)
				}
				mainRoom.mu.Unlock()
			}
		}

		if mok {
			h.broadcastRoomUpdate(mainRoom)
		}

		peer.mu.Lock()
		peer.RoomID = ""
		peer.MainRoomID = ""
		peer.mu.Unlock()

		log.Printf("peer %s removed from sub-channel %s", peer.ID, roomID)
		return
	}
	h.mu.Unlock()

	h.RemoveTrackFromPeers(peer, room)

	room.mu.Lock()
	room.RemovePeer(peer.ID)
	room.mu.Unlock()

	h.ClosePeerConnection(peer)

	if room.ParentID == "" {
		h.broadcastRoomUpdate(room)
	} else {
		h.mu.RLock()
		mainRoom, ok := h.Rooms[mainRoomID]
		h.mu.RUnlock()
		if ok {
			h.broadcastRoomUpdate(mainRoom)
		}
	}

	peer.mu.Lock()
	peer.RoomID = ""
	peer.MainRoomID = ""
	peer.mu.Unlock()

	log.Printf("peer %s removed from room %s", peer.ID, roomID)
}

func (h *Hub) HandleChat(peer *Peer, ciphertext string) {
	peer.mu.RLock()
	roomID := peer.RoomID
	peerID := peer.ID
	peerName := peer.Name
	peer.mu.RUnlock()

	if roomID == "" {
		return
	}

	msgID := uuid.New().String()
	now := time.Now().UnixMilli()

	msg := ChatMessage{
		ID:         msgID,
		UserID:     peerID,
		UserName:   peerName,
		Ciphertext: ciphertext,
		Timestamp:  now,
	}

	var room *Room
	h.mu.RLock()
	room = h.Rooms[roomID]
	if room == nil {
		for _, r := range h.Rooms {
			r.mu.RLock()
			if sub, ok := r.SubChannels[roomID]; ok {
				room = sub
				r.mu.RUnlock()
				break
			}
			r.mu.RUnlock()
		}
	}
	h.mu.RUnlock()

	if room == nil {
		return
	}

	room.mu.Lock()
	room.AddChatMessage(msg, h.chatHistorySize)
	room.mu.Unlock()

	outMsg := ChatMessageOut{
		ID:         msgID,
		UserID:     peerID,
		UserName:   peerName,
		Ciphertext: ciphertext,
		Timestamp:  now,
		ChannelID:  roomID,
	}
	room.BroadcastToChannel("chat", outMsg, "")
}

func (h *Hub) HandleMute(peer *Peer, muted bool) {
	peer.mu.Lock()
	peer.Muted = muted
	mainRoomID := peer.MainRoomID
	peer.mu.Unlock()

	h.mu.RLock()
	mainRoom, ok := h.Rooms[mainRoomID]
	h.mu.RUnlock()

	if ok {
		h.broadcastRoomUpdate(mainRoom)
	}
}

func (h *Hub) HandleSubInvite(fromPeer *Peer, targetUserID, channelName string) {
	fromPeer.mu.RLock()
	fromRoomID := fromPeer.RoomID
	fromMainRoomID := fromPeer.MainRoomID
	fromPeer.mu.RUnlock()

	if fromRoomID != fromMainRoomID {
		fromPeer.SendError(ErrAlreadyInSub, "You are already in a sub-channel")
		return
	}

	h.mu.RLock()
	mainRoom, ok := h.Rooms[fromMainRoomID]
	h.mu.RUnlock()
	if !ok {
		fromPeer.SendError(ErrInternalError, "Room not found")
		return
	}

	mainRoom.mu.RLock()
	targetPeer, found := mainRoom.Peers[targetUserID]
	mainRoom.mu.RUnlock()

	if !found {
		fromPeer.SendError(ErrChannelNotFound, "User not found in main channel")
		return
	}

	targetPeer.mu.RLock()
	targetRoomID := targetPeer.RoomID
	targetMainRoomID := targetPeer.MainRoomID
	targetPeer.mu.RUnlock()

	if targetRoomID != targetMainRoomID {
		fromPeer.SendError(ErrAlreadyInSub, "Target user is already in a sub-channel")
		return
	}

	inviteID := uuid.New().String()

	timer := time.AfterFunc(30*time.Second, func() {
		h.mu.Lock()
		inv, exists := h.PendingInvites[inviteID]
		if exists {
			delete(h.PendingInvites, inviteID)
		}
		h.mu.Unlock()

		if exists {
			inv.FromPeer.SendJSON("invite-expired", InviteExpiredPayload{
				InviteID: inviteID,
				Reason:   "timeout",
			})
			inv.ToPeer.SendJSON("invite-expired", InviteExpiredPayload{
				InviteID: inviteID,
				Reason:   "timeout",
			})
		}
	})

	if channelName == "" {
		channelName = "Private"
	}

	invite := &PendingInvite{
		ID:          inviteID,
		FromPeer:    fromPeer,
		ToPeer:      targetPeer,
		MainRoom:    mainRoom,
		ChannelName: channelName,
		Timer:       timer,
		CreatedAt:   time.Now(),
	}

	h.mu.Lock()
	h.PendingInvites[inviteID] = invite
	h.mu.Unlock()

	fromPeer.mu.RLock()
	fromName := fromPeer.Name
	fromID := fromPeer.ID
	fromPeer.mu.RUnlock()

	targetPeer.SendJSON("invite-req", InviteReqPayload{
		InviteID:    inviteID,
		FromUserID:  fromID,
		FromName:    fromName,
		ChannelName: channelName,
	})
}

func (h *Hub) HandleSubResponse(peer *Peer, inviteID string, accepted bool) {
	h.mu.Lock()
	invite, ok := h.PendingInvites[inviteID]
	if ok {
		delete(h.PendingInvites, inviteID)
		invite.Timer.Stop()
	}
	h.mu.Unlock()

	if !ok {
		peer.SendError(ErrInviteExpired, "Invite has expired or was not found")
		return
	}

	if !accepted {
		invite.FromPeer.SendJSON("invite-expired", InviteExpiredPayload{
			InviteID: inviteID,
			Reason:   "declined",
		})
		return
	}

	subID := uuid.New().String()
	mainRoom := invite.MainRoom

	subRoom := &Room{
		ID:          subID,
		Name:        invite.ChannelName,
		FullName:    mainRoom.FullName,
		ParentID:    mainRoom.ID,
		PasswordHash: mainRoom.PasswordHash,
		Peers:       make(map[string]*Peer),
		SubChannels: make(map[string]*Room),
		ChatHistory: make([]ChatMessage, 0),
	}

	// Save tracks before closing PCs — we need them to remove from remaining peers.
	invite.FromPeer.RLock()
	fromTrack := invite.FromPeer.Track
	invite.FromPeer.RUnlock()

	invite.ToPeer.RLock()
	toTrack := invite.ToPeer.Track
	invite.ToPeer.RUnlock()

	// Close PCs FIRST so the moving peers don't receive spurious renegotiation
	// offers (their PC is about to be replaced for the sub-channel).
	h.ClosePeerConnection(invite.FromPeer)
	h.ClosePeerConnection(invite.ToPeer)

	// Remove tracks from remaining main room peers only (moving peers have PC=nil).
	h.removeTrackFromRoomPeers(fromTrack, mainRoom)
	h.removeTrackFromRoomPeers(toTrack, mainRoom)

	mainRoom.mu.Lock()
	mainRoom.RemovePeer(invite.FromPeer.ID)
	mainRoom.RemovePeer(invite.ToPeer.ID)
	mainRoom.SubChannels[subID] = subRoom
	mainRoom.mu.Unlock()

	subRoom.mu.Lock()
	invite.FromPeer.mu.Lock()
	invite.FromPeer.RoomID = subID
	invite.FromPeer.mu.Unlock()
	subRoom.AddPeer(invite.FromPeer)

	invite.ToPeer.mu.Lock()
	invite.ToPeer.RoomID = subID
	invite.ToPeer.mu.Unlock()
	subRoom.AddPeer(invite.ToPeer)
	subRoom.mu.Unlock()

	log.Printf("sub-channel %s created in room %s", subID, mainRoom.FullName)

	for _, p := range []*Peer{invite.FromPeer, invite.ToPeer} {
		if err := h.CreatePeerConnection(p, subRoom); err != nil {
			log.Printf("failed to create PC for %s in sub-channel: %v", p.ID, err)
			continue
		}
		h.AddTrackToPeers(p, subRoom)
		if err := h.SendOffer(p); err != nil {
			log.Printf("failed to send offer to %s in sub-channel: %v", p.ID, err)
		}
	}

	h.broadcastRoomUpdate(mainRoom)
}

func (h *Hub) HandleMoveToMain(peer *Peer) {
	peer.mu.RLock()
	roomID := peer.RoomID
	mainRoomID := peer.MainRoomID
	peer.mu.RUnlock()

	if roomID == mainRoomID {
		return
	}

	h.mu.RLock()
	mainRoom, ok := h.Rooms[mainRoomID]
	h.mu.RUnlock()
	if !ok {
		return
	}

	mainRoom.mu.RLock()
	sub, subOk := mainRoom.SubChannels[roomID]
	mainRoom.mu.RUnlock()

	if subOk {
		h.RemoveTrackFromPeers(peer, sub)
	}
	h.ClosePeerConnection(peer)

	mainRoom.mu.Lock()
	if subOk {
		sub.mu.Lock()
		sub.RemovePeer(peer.ID)
		sub.mu.Unlock()
	}

	peer.mu.Lock()
	peer.RoomID = mainRoomID
	peer.mu.Unlock()

	mainRoom.AddPeer(peer)
	mainRoom.mu.Unlock()

	if subOk {
		h.sendSubCountdownIfNeeded(sub)

		// Immediately clean up empty sub-channels
		mainRoom.mu.Lock()
		sub.mu.RLock()
		subEmpty := len(sub.Peers) == 0
		sub.mu.RUnlock()
		if subEmpty {
			delete(mainRoom.SubChannels, sub.ID)
		}
		mainRoom.mu.Unlock()
	}

	if err := h.CreatePeerConnection(peer, mainRoom); err != nil {
		log.Printf("failed to create PC for %s moving to main: %v", peer.ID, err)
	} else {
		h.AddTrackToPeers(peer, mainRoom)
		if err := h.SendOffer(peer); err != nil {
			log.Printf("failed to send offer to %s: %v", peer.ID, err)
		}
	}

	h.sendChatHistory(peer, mainRoom)

	h.broadcastRoomUpdate(mainRoom)
}

func (h *Hub) HandleMoveToSub(peer *Peer, targetSubID string) {
	peer.mu.RLock()
	currentRoomID := peer.RoomID
	mainRoomID := peer.MainRoomID
	peer.mu.RUnlock()

	if currentRoomID == targetSubID {
		return // Already in that sub-channel
	}

	h.mu.RLock()
	mainRoom, ok := h.Rooms[mainRoomID]
	h.mu.RUnlock()
	if !ok {
		peer.SendError(ErrChannelNotFound, "Room not found")
		return
	}

	mainRoom.mu.RLock()
	targetSub, subOk := mainRoom.SubChannels[targetSubID]
	mainRoom.mu.RUnlock()
	if !subOk {
		peer.SendError(ErrChannelNotFound, "Sub-channel not found")
		return
	}

	if currentRoomID == mainRoomID {
		h.RemoveTrackFromPeers(peer, mainRoom)
	} else {
		mainRoom.mu.RLock()
		currentSub, csOk := mainRoom.SubChannels[currentRoomID]
		mainRoom.mu.RUnlock()
		if csOk {
			h.RemoveTrackFromPeers(peer, currentSub)
		}
	}
	h.ClosePeerConnection(peer)

	mainRoom.mu.Lock()
	if currentRoomID == mainRoomID {
		mainRoom.RemovePeer(peer.ID)
	} else {
		if currentSub, csOk := mainRoom.SubChannels[currentRoomID]; csOk {
			currentSub.mu.Lock()
			currentSub.RemovePeer(peer.ID)
			currentSub.mu.Unlock()
		}
	}
	mainRoom.mu.Unlock()

	if currentRoomID != mainRoomID {
		mainRoom.mu.RLock()
		oldSub, oldOk := mainRoom.SubChannels[currentRoomID]
		mainRoom.mu.RUnlock()
		if oldOk {
			h.sendSubCountdownIfNeeded(oldSub)

			// Immediately clean up empty sub-channels
			mainRoom.mu.Lock()
			oldSub.mu.RLock()
			oldSubEmpty := len(oldSub.Peers) == 0
			oldSub.mu.RUnlock()
			if oldSubEmpty {
				delete(mainRoom.SubChannels, currentRoomID)
			}
			mainRoom.mu.Unlock()
		}
	}

	peer.mu.Lock()
	peer.RoomID = targetSubID
	peer.mu.Unlock()

	targetSub.mu.Lock()
	targetSub.AddPeer(peer)
	targetSub.mu.Unlock()

	h.sendSubCountdownIfNeeded(targetSub)

	if err := h.CreatePeerConnection(peer, targetSub); err != nil {
		log.Printf("failed to create PC for %s moving to sub: %v", peer.ID, err)
	} else {
		h.AddTrackToPeers(peer, targetSub)
		if err := h.SendOffer(peer); err != nil {
			log.Printf("failed to send offer to %s: %v", peer.ID, err)
		}
	}

	h.sendChatHistory(peer, targetSub)

	h.broadcastRoomUpdate(mainRoom)
}

func (h *Hub) sendSubCountdownIfNeeded(sub *Room) {
	sub.mu.Lock()
	peerCount := len(sub.Peers)
	subID := sub.ID

	if peerCount == 1 {
		if sub.CountdownExpiresAt == 0 {
			expiresAt := time.Now().Add(5 * time.Minute).UnixMilli()
			sub.CountdownExpiresAt = expiresAt
			sub.Expiry = time.Now()

			time.AfterFunc(5*time.Minute, func() {
				h.cleanupExpiredSubChannel(subID)
			})
		}
	} else {
		sub.CountdownExpiresAt = 0
		if peerCount >= 2 {
			sub.Expiry = time.Time{}
		}
	}
	sub.mu.Unlock()
}

func (h *Hub) cleanupExpiredSubChannel(subID string) {
	h.mu.RLock()
	var mainRoom *Room
	var sub *Room
	for _, room := range h.Rooms {
		if room.ParentID != "" {
			continue
		}
		room.mu.RLock()
		if s, ok := room.SubChannels[subID]; ok {
			mainRoom = room
			sub = s
		}
		room.mu.RUnlock()
		if mainRoom != nil {
			break
		}
	}
	h.mu.RUnlock()

	if mainRoom == nil || sub == nil {
		return
	}

	sub.mu.RLock()
	peerCount := len(sub.Peers)
	sub.mu.RUnlock()

	if peerCount > 1 {
		return // Countdown was cancelled (more peers joined)
	}

	if peerCount == 1 {
		sub.mu.RLock()
		var lastPeer *Peer
		for _, p := range sub.Peers {
			lastPeer = p
		}
		sub.mu.RUnlock()

		if lastPeer != nil {
			h.HandleMoveToMain(lastPeer)
		}
	} else {
		mainRoom.mu.Lock()
		delete(mainRoom.SubChannels, subID)
		mainRoom.mu.Unlock()
		h.broadcastRoomUpdate(mainRoom)
	}
}

func (h *Hub) BroadcastRoomUpdatePublic(mainRoom *Room) {
	h.broadcastRoomUpdate(mainRoom)
}

func (h *Hub) broadcastRoomUpdate(mainRoom *Room) {
	mainRoom.mu.RLock()
	users := mainRoom.GetUserInfos()
	subChannels := mainRoom.GetSubChannelInfos()
	allPeers := mainRoom.AllPeersInMainAndSubs()
	mainRoom.mu.RUnlock()

	update := RoomUpdatePayload{
		Users:       users,
		SubChannels: subChannels,
	}

	for _, p := range allPeers {
		p.SendJSON("room-update", update)
	}
}

func (h *Hub) sendChatHistory(peer *Peer, room *Room) {
	room.mu.RLock()
	history := room.GetChatHistoryOut()
	roomID := room.ID
	room.mu.RUnlock()

	peer.SendJSON("chat-history", ChatHistoryPayload{
		ChannelID: roomID,
		Messages:  history,
	})
}

func (h *Hub) BuildWelcomePayload(peer *Peer, room *Room, sessionToken string) WelcomePayload {
	room.mu.RLock()
	users := room.GetUserInfos()
	subChannels := room.GetSubChannelInfos()
	chatHistory := room.GetChatHistoryOut()
	room.mu.RUnlock()

	peer.mu.RLock()
	currentChannelID := peer.RoomID
	peer.mu.RUnlock()

	return WelcomePayload{
		UserID:       peer.ID,
		SessionToken: sessionToken,
		InviteToken:  room.InviteToken,
		RoomState: RoomStatePayload{
			ID:               room.ID,
			Name:             room.Name,
			FullName:         room.FullName,
			CurrentChannelID: currentChannelID,
			Users:            users,
			SubChannels:      subChannels,
			ChatHistory:      chatHistory,
		},
	}
}

func (h *Hub) startGC() {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		h.gc()
	}
}

func (h *Hub) gc() {
	now := time.Now()

	h.mu.Lock()
	defer h.mu.Unlock()

	for token, peer := range h.SessionMap {
		peer.mu.RLock()
		age := now.Sub(peer.SessionCreatedAt)
		peer.mu.RUnlock()
		if age > 24*time.Hour {
			delete(h.SessionMap, token)
		}
	}

	for token, room := range h.InviteMap {
		if now.Sub(room.CreatedAt) > 7*24*time.Hour {
			delete(h.InviteMap, token)
		}
	}

	cutoff := now.Add(-10 * time.Minute)
	for ip, times := range h.roomCreatesPerIP {
		filtered := times[:0]
		for _, t := range times {
			if t.After(cutoff) {
				filtered = append(filtered, t)
			}
		}
		if len(filtered) == 0 {
			delete(h.roomCreatesPerIP, ip)
		} else {
			h.roomCreatesPerIP[ip] = filtered
		}
	}

	for roomID, room := range h.Rooms {
		if room.ParentID != "" {
			continue // Skip sub-channels; handled via their parent
		}

		room.mu.Lock()

		for subID, sub := range room.SubChannels {
			sub.mu.Lock()

			if len(sub.Peers) == 0 && !sub.Expiry.IsZero() && now.Sub(sub.Expiry) > 5*time.Minute {
				delete(room.SubChannels, subID)
				log.Printf("GC: deleted empty sub-channel %s", subID)
				sub.mu.Unlock()
				continue
			}

			if len(sub.Peers) == 1 && !sub.Expiry.IsZero() && now.Sub(sub.Expiry) > 5*time.Minute {
				for _, p := range sub.Peers {
					p.mu.Lock()
					p.RoomID = room.ID
					p.mu.Unlock()
					room.AddPeer(p)
				}
				sub.Peers = make(map[string]*Peer)
				delete(room.SubChannels, subID)
				log.Printf("GC: force-moved last peer from sub-channel %s to main", subID)
			}

			sub.mu.Unlock()
		}

		totalPeers := len(room.Peers)
		for _, sub := range room.SubChannels {
			sub.mu.RLock()
			totalPeers += len(sub.Peers)
			sub.mu.RUnlock()
		}

		if totalPeers == 0 && !room.Expiry.IsZero() && now.Sub(room.Expiry) > 30*time.Minute {
			delete(h.Rooms, roomID)
			delete(h.RoomsByName, room.FullName)
			delete(h.InviteMap, room.InviteToken)
			log.Printf("GC: deleted room %s (%s)", room.FullName, roomID)
		}

		room.mu.Unlock()
	}
}
