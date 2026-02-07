import { create } from 'zustand';
import type { User, SubChannel, ChatMessage, InviteRequest } from '../types';

export type Theme = 'dark' | 'light';
export type VoiceMode = 'vad' | 'ptt';

interface Toast {
  id: string;
  message: string;
}

interface AppState {
  connected: boolean;
  reconnecting: boolean;

  userId: string | null;
  sessionToken: string | null;
  username: string;

  roomId: string | null;
  roomName: string | null;
  roomFullName: string | null;
  inviteToken: string | null;
  currentChannelId: string | null;
  password: string | null;
  e2eKey: CryptoKey | null;

  users: User[];
  subChannels: SubChannel[];

  chatMessages: Record<string, ChatMessage[]>;

  theme: Theme;
  muted: boolean;
  outputMuted: boolean;
  settingsOpen: boolean;
  pendingInvite: InviteRequest | null;
  toasts: Toast[];

  userVolumes: Record<string, number>;

  audioInputDeviceId: string | null;
  audioOutputDeviceId: string | null;
  voiceMode: VoiceMode;
  vadThreshold: number;
  webrtcUnavailable: boolean;

  setTheme: (theme: Theme) => void;
  setConnectionState: (connected: boolean) => void;
  setReconnecting: (reconnecting: boolean) => void;
  setUser: (userId: string, sessionToken: string, username: string) => void;
  setRoomState: (room: {
    id: string;
    name: string;
    fullName: string;
    currentChannelId: string;
    inviteToken: string;
  }) => void;
  setPassword: (password: string | null) => void;
  setE2eKey: (key: CryptoKey | null) => void;
  updateUsers: (users: User[], subChannels: SubChannel[]) => void;
  addChatMessage: (channelId: string, msg: ChatMessage) => void;
  setChatHistory: (channelId: string, messages: ChatMessage[]) => void;
  setMuted: (muted: boolean) => void;
  setOutputMuted: (muted: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setPendingInvite: (invite: InviteRequest | null) => void;
  setCurrentChannelId: (channelId: string) => void;
  addToast: (message: string) => void;
  removeToast: (id: string) => void;
  setUserVolume: (userId: string, volume: number) => void;
  setAudioInputDeviceId: (id: string | null) => void;
  setAudioOutputDeviceId: (id: string | null) => void;
  setVoiceMode: (mode: VoiceMode) => void;
  setVadThreshold: (threshold: number) => void;
  setWebrtcUnavailable: (unavailable: boolean) => void;
  reset: () => void;
}

function getInitialTheme(): Theme {
  const stored = localStorage.getItem('qvoch-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return 'dark';
}

function getStoredVoiceMode(): VoiceMode {
  const stored = localStorage.getItem('qvoch-voice-mode');
  if (stored === 'ptt') return 'ptt';
  return 'vad';
}

function getStoredVadThreshold(): number {
  const stored = localStorage.getItem('qvoch-vad-threshold');
  if (stored) {
    const n = Number(stored);
    if (!isNaN(n) && n >= 0 && n <= 100) return n;
  }
  return 15;
}

const initialState = {
  connected: false,
  reconnecting: false,
  userId: null,
  sessionToken: null,
  username: '',
  roomId: null,
  roomName: null,
  roomFullName: null,
  inviteToken: null,
  currentChannelId: null,
  password: null,
  e2eKey: null,
  users: [],
  subChannels: [],
  chatMessages: {},
  theme: getInitialTheme(),
  muted: false,
  outputMuted: false,
  settingsOpen: false,
  pendingInvite: null,
  toasts: [] as Toast[],
  userVolumes: {} as Record<string, number>,
  audioInputDeviceId: localStorage.getItem('qvoch-audio-input') || null,
  audioOutputDeviceId: localStorage.getItem('qvoch-audio-output') || null,
  voiceMode: getStoredVoiceMode(),
  vadThreshold: getStoredVadThreshold(),
  webrtcUnavailable: false,
};

export const useStore = create<AppState>((set) => ({
  ...initialState,

  setTheme: (theme) => {
    localStorage.setItem('qvoch-theme', theme);
    document.documentElement.dataset.theme = theme;
    set({ theme });
  },

  setConnectionState: (connected) => set({ connected }),
  setReconnecting: (reconnecting) => set({ reconnecting }),

  setUser: (userId, sessionToken, username) =>
    set({ userId, sessionToken, username }),

  setRoomState: (room) =>
    set({
      roomId: room.id,
      roomName: room.name,
      roomFullName: room.fullName,
      currentChannelId: room.currentChannelId,
      inviteToken: room.inviteToken,
    }),

  setPassword: (password) => set({ password }),
  setE2eKey: (key) => set({ e2eKey: key }),

  updateUsers: (users, subChannels) => set({ users, subChannels }),

  addChatMessage: (channelId, msg) =>
    set((state) => ({
      chatMessages: {
        ...state.chatMessages,
        [channelId]: [...(state.chatMessages[channelId] || []), msg],
      },
    })),

  setChatHistory: (channelId, messages) =>
    set((state) => ({
      chatMessages: {
        ...state.chatMessages,
        [channelId]: messages,
      },
    })),

  setMuted: (muted) => set({ muted }),
  setOutputMuted: (muted) => set({ outputMuted: muted }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setPendingInvite: (invite) => set({ pendingInvite: invite }),
  setCurrentChannelId: (channelId) => set({ currentChannelId: channelId }),

  addToast: (message) =>
    set((state) => ({
      toasts: [...state.toasts, { id: crypto.randomUUID(), message }],
    })),
  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),

  setUserVolume: (userId, volume) =>
    set((state) => ({
      userVolumes: { ...state.userVolumes, [userId]: volume },
    })),

  setAudioInputDeviceId: (id) => {
    if (id) localStorage.setItem('qvoch-audio-input', id);
    else localStorage.removeItem('qvoch-audio-input');
    set({ audioInputDeviceId: id });
  },
  setAudioOutputDeviceId: (id) => {
    if (id) localStorage.setItem('qvoch-audio-output', id);
    else localStorage.removeItem('qvoch-audio-output');
    set({ audioOutputDeviceId: id });
  },
  setVoiceMode: (mode) => {
    localStorage.setItem('qvoch-voice-mode', mode);
    set({ voiceMode: mode });
  },
  setVadThreshold: (threshold) => {
    localStorage.setItem('qvoch-vad-threshold', String(threshold));
    set({ vadThreshold: threshold });
  },
  setWebrtcUnavailable: (unavailable) => set({ webrtcUnavailable: unavailable }),

  reset: () => set(initialState),
}));
