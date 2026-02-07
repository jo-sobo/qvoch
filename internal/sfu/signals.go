package sfu

import "encoding/json"

type Envelope struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

type CreatePayload struct {
	Username    string `json:"username"`
	ChannelName string `json:"channelName"`
	Password    string `json:"password"`
}

type JoinPayload struct {
	Username     string `json:"username"`
	ChannelName  string `json:"channelName"`
	Password     string `json:"password"`
	InviteToken  string `json:"inviteToken"`
	SessionToken string `json:"sessionToken"`
}

type AnswerPayload struct {
	SDP string `json:"sdp"`
}

type CandidatePayload struct {
	Candidate     string `json:"candidate"`
	SDPMid        string `json:"sdpMid"`
	SDPMLineIndex *int   `json:"sdpMLineIndex"`
}

type ChatPayload struct {
	Ciphertext string `json:"ciphertext"`
}

type MutePayload struct {
	Muted bool `json:"muted"`
}

type SubInvitePayload struct {
	TargetUserID string `json:"targetUserId"`
	ChannelName  string `json:"channelName"`
}

type SubResponsePayload struct {
	InviteID string `json:"inviteId"`
	Accepted bool   `json:"accepted"`
}

type MoveToMainPayload struct{}

type MoveToSubPayload struct {
	SubChannelID string `json:"subChannelId"`
}

type LeavePayload struct{}

type UserInfo struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	Muted        bool    `json:"muted"`
	InSubChannel *string `json:"inSubChannel"`
}

type SubChannelInfo struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Users     []UserInfo `json:"users"`
	ExpiresAt int64      `json:"expiresAt,omitempty"`
}

type RoomStatePayload struct {
	ID               string           `json:"id"`
	Name             string           `json:"name"`
	FullName         string           `json:"fullName"`
	CurrentChannelID string           `json:"currentChannelId"`
	Users            []UserInfo       `json:"users"`
	SubChannels      []SubChannelInfo `json:"subChannels"`
	ChatHistory      []ChatMessageOut `json:"chatHistory"`
}

type WelcomePayload struct {
	UserID       string           `json:"userId"`
	SessionToken string           `json:"sessionToken"`
	InviteToken  string           `json:"inviteToken"`
	RoomState    RoomStatePayload `json:"roomState"`
}

type ErrorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type RoomUpdatePayload struct {
	Users       []UserInfo       `json:"users"`
	SubChannels []SubChannelInfo `json:"subChannels"`
}

type OfferPayload struct {
	SDP   string `json:"sdp"`
	Reset bool   `json:"reset,omitempty"`
}

type ChatMessageOut struct {
	ID         string `json:"id"`
	UserID     string `json:"userId"`
	UserName   string `json:"userName"`
	Ciphertext string `json:"ciphertext"`
	Timestamp  int64  `json:"timestamp"`
	ChannelID  string `json:"channelId,omitempty"`
}

type InviteReqPayload struct {
	InviteID    string `json:"inviteId"`
	FromUserID  string `json:"fromUserId"`
	FromName    string `json:"fromName"`
	ChannelName string `json:"channelName"`
}

type SubCountdownPayload struct {
	SubChannelID string `json:"subChannelId"`
	ExpiresAt    int64  `json:"expiresAt"`
}

type InviteExpiredPayload struct {
	InviteID string `json:"inviteId"`
	Reason   string `json:"reason"`
}

type ChatHistoryPayload struct {
	ChannelID string           `json:"channelId"`
	Messages  []ChatMessageOut `json:"messages"`
}

const (
	ErrAuthFailed       = "AUTH_FAILED"
	ErrPasswordRequired = "PASSWORD_REQUIRED"
	ErrPasswordWrong    = "PASSWORD_WRONG"
	ErrChannelFull      = "CHANNEL_FULL"
	ErrServerFull       = "SERVER_FULL"
	ErrNameTaken        = "NAME_TAKEN"
	ErrChannelNotFound  = "CHANNEL_NOT_FOUND"
	ErrAlreadyInSub     = "ALREADY_IN_SUB"
	ErrInviteExpired    = "INVITE_EXPIRED"
	ErrInvalidMessage   = "INVALID_MESSAGE"
	ErrInternalError    = "INTERNAL_ERROR"
)
