import { useStore } from '../stores/useStore';
import { handleOffer, handleCandidate as handleRTCCandidate, initLocalAudio, ensureAudioContext, resetLocalAudioPromise, isLocalAudioReady, closeWebRTC } from './webrtc';
import { deriveRoomKey, decryptMessage, exportKey, storeRoomKey, importKey, getRoomKey } from './crypto';
import type {
  WelcomePayload,
  ErrorPayload,
  RoomUpdatePayload,
  ChatMessage,
  OfferPayload,
  CandidatePayload,
  InviteReqPayload,
  InviteExpiredPayload,
} from '../types';
import type { User } from '../types';

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSessionFallback: { username: string; inviteToken: string } | null = null;

let sessionChannel: BroadcastChannel | null = null;

function initBroadcastChannel(): void {
  if (!('BroadcastChannel' in window) || sessionChannel) return;

  sessionChannel = new BroadcastChannel('qvoch-session');
  sessionChannel.onmessage = (event) => {
    if (event.data === 'active') {
      const store = useStore.getState();
      if (store.roomId) {
        store.addToast('Connected in another tab. This tab will be disconnected.');
        disconnect();
        closeWebRTC();
        store.reset();
        window.location.hash = '#/';
      }
    }
  };
}

export function isOtherTabActive(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!('BroadcastChannel' in window)) {
      resolve(false);
      return;
    }
    const probe = new BroadcastChannel('qvoch-session');
    let answered = false;

    probe.onmessage = (event) => {
      if (event.data === 'active-ack') {
        answered = true;
        probe.close();
        resolve(true);
      }
    };

    probe.postMessage('probe');

    setTimeout(() => {
      if (!answered) {
        probe.close();
        resolve(false);
      }
    }, 200);
  });
}

function getWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

function getReconnectDelay(): number {
  const delays = [1000, 2000, 4000, 8000];
  const delay = delays[Math.min(reconnectAttempts, delays.length - 1)];
  return Math.min(delay, 30000);
}

function clearPersistedRejoinState(): void {
  localStorage.removeItem('sessionToken');
  localStorage.removeItem('qvoch-session-token');
  localStorage.removeItem('qvoch-session-time');
  localStorage.removeItem('qvoch-session-username');
  localStorage.removeItem('qvoch-session-invite');
}

export function connect(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  initBroadcastChannel();

  const store = useStore.getState();
  store.setReconnecting(reconnectAttempts > 0);

  const thisWs = new WebSocket(getWsUrl());
  ws = thisWs;

  thisWs.onopen = () => {
    reconnectAttempts = 0;
    const store = useStore.getState();
    store.setConnectionState(true);
    store.setReconnecting(false);

    // Auto-rejoin room after WebSocket reconnect.
    // Init audio first so local tracks are available when the offer arrives.
    if (store.roomId && store.username) {
      const { username, sessionToken, inviteToken, audioInputDeviceId } = store;
      resetLocalAudioPromise();
      initLocalAudio(audioInputDeviceId)
        .catch(() => {})
        .then(() => {
          if (sessionToken) {
            if (inviteToken) {
              pendingSessionFallback = { username, inviteToken };
            }
            send('join', { username, sessionToken });
          } else if (inviteToken) {
            pendingSessionFallback = null;
            send('join', { username, inviteToken });
          }
        });
    }
  };

  thisWs.onclose = () => {
    // Only null out `ws` if this is still the active socket.
    // Prevents a stale onclose from killing a newer connection.
    if (ws === thisWs) {
      ws = null;
    }
    const store = useStore.getState();
    store.setConnectionState(false);

    if (store.roomId) {
      scheduleReconnect();
    }
  };

  thisWs.onerror = () => {
  };

  thisWs.onmessage = (event) => {
    try {
      const envelope = JSON.parse(event.data as string) as { type: string; payload: unknown };
      handleMessage(envelope.type, envelope.payload);
    } catch {
      console.error('Failed to parse WebSocket message');
    }
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;

  reconnectAttempts++;
  const delay = getReconnectDelay();
  const store = useStore.getState();
  store.setReconnecting(true);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

export function disconnect(): void {
  pendingSessionFallback = null;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
  if (ws) {
    ws.close();
    ws = null;
  }
}

export function send(type: string, payload: unknown): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('WebSocket not connected, cannot send:', type);
    return false;
  }
  ws.send(JSON.stringify({ type, payload }));
  return true;
}

function handleMessage(type: string, payload: unknown): void {
  const store = useStore.getState();

  switch (type) {
    case 'welcome': {
      const p = payload as WelcomePayload;
      store.setUser(p.userId, p.sessionToken, store.username);
      store.setRoomState({
        id: p.roomState.id,
        name: p.roomState.name,
        fullName: p.roomState.fullName,
        currentChannelId: p.roomState.currentChannelId,
        inviteToken: p.inviteToken,
      });
      store.updateUsers(p.roomState.users, p.roomState.subChannels);

      localStorage.setItem('sessionToken', p.sessionToken);
      localStorage.setItem('qvoch-session-token', p.sessionToken);
      pendingSessionFallback = null;

      if (p.reconnectNotice) {
        store.addToast(p.reconnectNotice);
      }

      sessionChannel?.postMessage('active');

      deriveE2EKey(p.roomState.fullName).then(async (key) => {
        if (!key) return;
        const currentStore = useStore.getState();

        if (p.roomState.chatHistory && p.roomState.chatHistory.length > 0) {
          const decryptedMessages: ChatMessage[] = [];
          for (const msg of p.roomState.chatHistory) {
            try {
              const plaintext = await decryptMessage(key, msg.ciphertext);
              decryptedMessages.push({ ...msg, plaintext });
            } catch {
              decryptedMessages.push({ ...msg, plaintext: '[unable to decrypt]' });
            }
          }
          currentStore.setChatHistory(p.roomState.currentChannelId, decryptedMessages);
        }
      });

      // Restore password from sessionStorage if not in store (page reload case)
      if (!store.password) {
        const savedPassword = sessionStorage.getItem('qvoch-password');
        if (savedPassword) {
          store.setPassword(savedPassword);
        }
      }

      ensureAudioContext();
      // Only init audio if not already available (mic was requested before join)
      if (!isLocalAudioReady()) {
        resetLocalAudioPromise();
        initLocalAudio(store.audioInputDeviceId).catch((err) => {
          console.error('Failed to get microphone:', err);
        });
      }

      persistSessionForRejoin();

      const targetHash = `#/room/${p.roomState.id}`;
      if (window.location.hash !== targetHash) {
        window.location.hash = targetHash;
      } else {
        // When hash is unchanged (e.g. page reload on same room route),
        // explicitly notify listeners so UI routing can sync to room view.
        window.dispatchEvent(new Event('hashchange'));
      }
      break;
    }

    case 'error': {
      const p = payload as ErrorPayload;
      console.error(`Server error [${p.code}]: ${p.message}`);

      if (
        pendingSessionFallback
        && (p.code === 'INVALID_MESSAGE' || p.code === 'CHANNEL_NOT_FOUND')
      ) {
        const fallback = pendingSessionFallback;
        pendingSessionFallback = null;
        send('join', { username: fallback.username, inviteToken: fallback.inviteToken });
        store.addToast('Session expired, rejoining via invite token...');
        break;
      }

      store.addToast(`Error: ${p.message}`);
      break;
    }

    case 'room-update': {
      const p = payload as RoomUpdatePayload;
      const prevUsers = store.users;
      store.updateUsers(p.users, p.subChannels);

      detectJoinLeave(prevUsers, p.users, store.userId);

      const myId = store.userId;
      if (myId) {
        for (const sub of p.subChannels) {
          if (sub.users.some((u) => u.id === myId)) {
            store.setCurrentChannelId(sub.id);
            return;
          }
        }
        if (store.roomId) {
          store.setCurrentChannelId(store.roomId);
        }
      }
      break;
    }

    case 'chat': {
      const msg = payload as ChatMessage;
      const channelId = msg.channelId || store.currentChannelId;
      if (channelId) {
        const key = store.e2eKey;
        if (key) {
          decryptMessage(key, msg.ciphertext)
            .then((plaintext) => {
              const currentStore = useStore.getState();
              currentStore.addChatMessage(channelId, { ...msg, plaintext });

              const myName = currentStore.username;
              if (myName && plaintext.includes(`@${myName}`)) {
                import('./sounds').then((m) => m.playMentionSound());
              }
            })
            .catch(() => {
              useStore.getState().addChatMessage(channelId, { ...msg, plaintext: '[unable to decrypt]' });
            });
        } else {
          store.addChatMessage(channelId, msg);
        }
      }
      break;
    }

    case 'chat-history': {
      const p = payload as { channelId: string; messages: ChatMessage[] };
      if (p.channelId && p.messages) {
        const key = store.e2eKey;
        if (key) {
          Promise.all(
            p.messages.map(async (msg) => {
              try {
                const plaintext = await decryptMessage(key, msg.ciphertext);
                return { ...msg, plaintext };
              } catch {
                return { ...msg, plaintext: '[unable to decrypt]' };
              }
            })
          ).then((decrypted) => {
            useStore.getState().setChatHistory(p.channelId, decrypted);
          });
        } else {
          store.setChatHistory(p.channelId, p.messages);
        }
      }
      break;
    }

    case 'offer': {
      const p = payload as OfferPayload;
      handleOffer(p.sdp, p.reset, p.seq, p.epoch);
      break;
    }

    case 'candidate': {
      const p = payload as CandidatePayload;
      handleRTCCandidate(p.candidate, p.sdpMid, p.sdpMLineIndex, p.seq, p.epoch);
      break;
    }

    case 'invite-req': {
      const p = payload as InviteReqPayload;
      store.setPendingInvite({
        inviteId: p.inviteId,
        fromUserId: p.fromUserId,
        fromName: p.fromName,
        channelName: p.channelName,
      });
      break;
    }

    case 'invite-expired': {
      const p = payload as InviteExpiredPayload;
      const pending = store.pendingInvite;
      if (pending && pending.inviteId === p.inviteId) {
        store.setPendingInvite(null);
      }
      break;
    }

    case '__internal_probe': break;
  }
}

function detectJoinLeave(prevUsers: User[], newUsers: User[], myUserId: string | null): void {
  const prevIds = new Set(prevUsers.map((u) => u.id));
  const newIds = new Set(newUsers.map((u) => u.id));

  let hasJoin = false;
  let hasLeave = false;

  for (const id of newIds) {
    if (!prevIds.has(id) && id !== myUserId) {
      hasJoin = true;
      break;
    }
  }

  for (const id of prevIds) {
    if (!newIds.has(id) && id !== myUserId) {
      hasLeave = true;
      break;
    }
  }

  if (hasJoin) {
    import('./sounds').then((m) => m.playJoinSound());
  }
  if (hasLeave) {
    import('./sounds').then((m) => m.playLeaveSound());
  }
}

async function deriveE2EKey(roomFullName: string): Promise<CryptoKey | null> {
  const store = useStore.getState();
  const password = store.password;

  if (password) {
    const key = await deriveRoomKey(password, roomFullName);
    store.setE2eKey(key);
    const keyB64 = await exportKey(key);
    storeRoomKey(roomFullName, keyB64);
    return key;
  }

  const cached = getRoomKey(roomFullName);
  if (cached) {
    try {
      const key = await importKey(cached);
      store.setE2eKey(key);
      return key;
    } catch {
      console.error('Failed to import cached key');
    }
  }

  return null;
}

export function persistSessionForRejoin(): void {
  const store = useStore.getState();
  if (store.roomId && store.username) {
    localStorage.setItem('qvoch-session-time', String(Date.now()));
    localStorage.setItem('qvoch-session-username', store.username);
    if (store.sessionToken) {
      localStorage.setItem('sessionToken', store.sessionToken);
      localStorage.setItem('qvoch-session-token', store.sessionToken);
    }
    if (store.inviteToken) {
      localStorage.setItem('qvoch-session-invite', store.inviteToken);
    } else {
      localStorage.removeItem('qvoch-session-invite');
    }
  }
}

export function leaveRoomAndReset(): void {
  send('leave', {});
  closeWebRTC();
  disconnect();
  clearPersistedRejoinState();
  sessionStorage.removeItem('qvoch-password');
  useStore.getState().reset();
  window.location.hash = '#/';
}

if ('BroadcastChannel' in window) {
  const probeListener = new BroadcastChannel('qvoch-session');
  probeListener.onmessage = (event) => {
    if (event.data === 'probe') {
      const store = useStore.getState();
      if (store.roomId) {
        probeListener.postMessage('active-ack');
      }
    }
  };
}
