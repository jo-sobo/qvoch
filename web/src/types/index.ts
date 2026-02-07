// --- Shared Types ---

export interface User {
  id: string;
  name: string;
  muted: boolean;
  inSubChannel: string | null;
}

export interface SubChannel {
  id: string;
  name: string;
  users: User[];
  expiresAt?: number;
}

export interface ChatMessage {
  id: string;
  userId: string;
  userName: string;
  ciphertext: string;
  plaintext?: string;
  timestamp: number;
  channelId?: string;
}

export interface RoomState {
  id: string;
  name: string;
  fullName: string;
  currentChannelId: string;
  users: User[];
  subChannels: SubChannel[];
  chatHistory: ChatMessage[];
}

export interface InviteRequest {
  inviteId: string;
  fromUserId: string;
  fromName: string;
  channelName: string;
}

// --- WebSocket Message Types ---

export interface Envelope {
  type: string;
  payload: unknown;
}

// Client -> Server

export interface CreatePayload {
  username: string;
  channelName: string;
  password: string;
}

export interface JoinPayload {
  username: string;
  channelName?: string;
  password?: string;
  inviteToken?: string;
  sessionToken?: string;
}

export interface AnswerPayload {
  sdp: string;
}

export interface CandidatePayload {
  candidate: string;
  sdpMid: string;
  sdpMLineIndex: number;
}

export interface ChatPayload {
  ciphertext: string;
}

export interface MutePayload {
  muted: boolean;
}

export interface SubInvitePayload {
  targetUserId: string;
  channelName?: string;
}

export interface SubResponsePayload {
  inviteId: string;
  accepted: boolean;
}

// Server -> Client

export interface WelcomePayload {
  userId: string;
  sessionToken: string;
  inviteToken: string;
  roomState: RoomState;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

export interface RoomUpdatePayload {
  users: User[];
  subChannels: SubChannel[];
}

export interface OfferPayload {
  sdp: string;
  reset?: boolean;
}

export interface InviteReqPayload {
  inviteId: string;
  fromUserId: string;
  fromName: string;
  channelName: string;
}

export interface InviteExpiredPayload {
  inviteId: string;
  reason: 'timeout' | 'declined';
}

