package sfu

import (
	"sync"
	"time"
)

type ChatMessage struct {
	ID         string `json:"id"`
	UserID     string `json:"userId"`
	UserName   string `json:"userName"`
	Ciphertext string `json:"ciphertext"`
	Timestamp  int64  `json:"timestamp"`
}

type Room struct {
	ID           string
	Name         string
	FullName     string
	InviteToken  string
	ParentID     string
	PasswordHash string
	CreatedAt    time.Time
	Peers        map[string]*Peer
	SubChannels  map[string]*Room
	ChatHistory        []ChatMessage
	Expiry             time.Time
	CountdownExpiresAt int64
	mu                 sync.RWMutex
}

func NewRoom(id, name, fullName, inviteToken, passwordHash string) *Room {
	return &Room{
		ID:           id,
		Name:         name,
		FullName:     fullName,
		InviteToken:  inviteToken,
		PasswordHash: passwordHash,
		CreatedAt:    time.Now(),
		Peers:        make(map[string]*Peer),
		SubChannels:  make(map[string]*Room),
		ChatHistory:  make([]ChatMessage, 0),
	}
}

func (r *Room) AddPeer(p *Peer) {
	r.Peers[p.ID] = p
	r.Expiry = time.Time{}
}

func (r *Room) RemovePeer(peerID string) {
	delete(r.Peers, peerID)
	if len(r.Peers) == 0 {
		r.Expiry = time.Now()
	}
}

func (r *Room) AddChatMessage(msg ChatMessage, maxSize int) {
	r.ChatHistory = append(r.ChatHistory, msg)
	if len(r.ChatHistory) > maxSize {
		r.ChatHistory = r.ChatHistory[len(r.ChatHistory)-maxSize:]
	}
}

func (r *Room) GetUserInfos() []UserInfo {
	users := make([]UserInfo, 0, len(r.Peers))
	for _, p := range r.Peers {
		p.mu.RLock()
		u := UserInfo{
			ID:    p.ID,
			Name:  p.Name,
			Muted: p.Muted,
		}
		p.mu.RUnlock()
		users = append(users, u)
	}

	for subID, sub := range r.SubChannels {
		sub.mu.RLock()
		for _, p := range sub.Peers {
			p.mu.RLock()
			subIDCopy := subID
			u := UserInfo{
				ID:           p.ID,
				Name:         p.Name,
				Muted:        p.Muted,
				InSubChannel: &subIDCopy,
			}
			p.mu.RUnlock()
			users = append(users, u)
		}
		sub.mu.RUnlock()
	}

	return users
}

func (r *Room) GetSubChannelInfos() []SubChannelInfo {
	infos := make([]SubChannelInfo, 0, len(r.SubChannels))
	for _, sub := range r.SubChannels {
		sub.mu.RLock()
		sci := SubChannelInfo{
			ID:        sub.ID,
			Name:      sub.Name,
			Users:     make([]UserInfo, 0, len(sub.Peers)),
			ExpiresAt: sub.CountdownExpiresAt,
		}
		for _, p := range sub.Peers {
			p.mu.RLock()
			sci.Users = append(sci.Users, UserInfo{
				ID:    p.ID,
				Name:  p.Name,
				Muted: p.Muted,
			})
			p.mu.RUnlock()
		}
		sub.mu.RUnlock()
		infos = append(infos, sci)
	}
	return infos
}

func (r *Room) GetChatHistoryOut() []ChatMessageOut {
	out := make([]ChatMessageOut, len(r.ChatHistory))
	for i, m := range r.ChatHistory {
		out[i] = ChatMessageOut{
			ID:         m.ID,
			UserID:     m.UserID,
			UserName:   m.UserName,
			Ciphertext: m.Ciphertext,
			Timestamp:  m.Timestamp,
		}
	}
	return out
}

func (r *Room) BroadcastToChannel(msgType string, payload interface{}, excludePeerID string) {
	r.mu.RLock()
	peers := make([]*Peer, 0, len(r.Peers))
	for _, p := range r.Peers {
		if p.ID != excludePeerID {
			peers = append(peers, p)
		}
	}
	r.mu.RUnlock()

	for _, p := range peers {
		p.SendJSON(msgType, payload)
	}
}

func (r *Room) AllPeersInMainAndSubs() []*Peer {
	all := make([]*Peer, 0)
	for _, p := range r.Peers {
		all = append(all, p)
	}
	for _, sub := range r.SubChannels {
		sub.mu.RLock()
		for _, p := range sub.Peers {
			all = append(all, p)
		}
		sub.mu.RUnlock()
	}
	return all
}
