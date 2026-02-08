import { useState, useEffect } from 'react';
import { useStore } from '../stores/useStore';
import { connect, send, isOtherTabActive } from '../services/socket';
import { initLocalAudio, resetLocalAudioPromise } from '../services/webrtc';
import { decodePasswordFromLink } from '../services/crypto';
import { Headphones, LogIn, Plus, Loader2 } from 'lucide-react';

type Tab = 'create' | 'join';

const REJOIN_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const REJOIN_KEYS = [
  'sessionToken',
  'qvoch-session-token',
  'qvoch-session-time',
  'qvoch-session-username',
  'qvoch-session-invite',
] as const;

function clearRejoinState(): void {
  for (const key of REJOIN_KEYS) {
    localStorage.removeItem(key);
  }
}

export function LandingPage() {
  const [tab, setTab] = useState<Tab>('create');
  const [username, setUsername] = useState('');
  const [channelName, setChannelName] = useState('');
  const [password, setPassword] = useState('');
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [invitePassword, setInvitePassword] = useState<string | null>(null);
  const [autoRejoining, setAutoRejoining] = useState(false);

  const setStorePassword = useStore((s) => s.setPassword);
  const connected = useStore((s) => s.connected);

  useEffect(() => {
    const hash = window.location.hash;
    const match = hash.match(/#\/join\/([^/]+)\/(.+)/);
    if (match) {
      const token = match[1];
      const encodedPw = match[2];
      try {
        const pw = decodePasswordFromLink(encodedPw);
        setInviteToken(token);
        setInvitePassword(pw);
        setTab('join');
      } catch {
        console.error('Failed to decode invite link');
      }
    }
  }, []);

  useEffect(() => {
    connect();
  }, []);

  useEffect(() => {
    const sessionToken = localStorage.getItem('qvoch-session-token') || localStorage.getItem('sessionToken');
    const sessionInvite = localStorage.getItem('qvoch-session-invite');
    const sessionTime = localStorage.getItem('qvoch-session-time');
    const sessionUsername = localStorage.getItem('qvoch-session-username');

    if (!sessionTime || !sessionUsername || (!sessionToken && !sessionInvite)) return;

    const elapsed = Date.now() - Number(sessionTime);
    if (elapsed > REJOIN_WINDOW_MS) {
      clearRejoinState();
      return;
    }

    isOtherTabActive().then((active) => {
      if (active) {
        useStore.getState().addToast('Already connected in another tab.');
        clearRejoinState();
        return;
      }
      setAutoRejoining(true);
      useStore.setState({ username: sessionUsername });
    });
  }, []);

  useEffect(() => {
    if (!autoRejoining || !connected) return;

    const sessionToken = localStorage.getItem('qvoch-session-token') || localStorage.getItem('sessionToken');
    const sessionInvite = localStorage.getItem('qvoch-session-invite');
    const sessionUsername = localStorage.getItem('qvoch-session-username');
    if (!sessionUsername || (!sessionToken && !sessionInvite)) {
      setAutoRejoining(false);
      return;
    }

    // Restore password from sessionStorage (survives page reload within same tab)
    const savedPassword = sessionStorage.getItem('qvoch-password');
    if (savedPassword) {
      useStore.getState().setPassword(savedPassword);
    }

    // Init audio before rejoining (permission already granted, resolves quickly)
    resetLocalAudioPromise();
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    initLocalAudio(useStore.getState().audioInputDeviceId)
      .catch(() => {})
      .then(() => {
        if (sessionToken) {
          send('join', {
            username: sessionUsername,
            sessionToken,
          });
          if (sessionInvite) {
            fallbackTimer = setTimeout(() => {
              if (!useStore.getState().roomId) {
                send('join', {
                  username: sessionUsername,
                  inviteToken: sessionInvite,
                });
              }
            }, 2500);
          }
        } else if (sessionInvite) {
          send('join', {
            username: sessionUsername,
            inviteToken: sessionInvite,
          });
        }
      });

    const timeout = setTimeout(() => {
      setAutoRejoining(false);
      if (!useStore.getState().roomId) {
        clearRejoinState();
      }
    }, 8000);

    return () => {
      clearTimeout(timeout);
      if (fallbackTimer) clearTimeout(fallbackTimer);
    };
  }, [autoRejoining, connected]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !channelName.trim() || password.length < 6) return;

    if (await isOtherTabActive()) {
      useStore.getState().addToast('Already connected in another tab.');
      return;
    }

    // Request mic permission before creating room (avoids ICE timeout while
    // the browser shows the permission dialog after the offer arrives)
    resetLocalAudioPromise();
    try {
      await initLocalAudio(useStore.getState().audioInputDeviceId);
    } catch {
      useStore.getState().addToast('Could not access microphone — voice chat won\'t work.');
    }

    const store = useStore.getState();
    store.setPassword(password);
    sessionStorage.setItem('qvoch-password', password);

    send('create', {
      username: username.trim(),
      channelName: channelName.trim(),
      password: password,
    });

    useStore.setState({ username: username.trim() });
  };

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) return;

    if (await isOtherTabActive()) {
      useStore.getState().addToast('Already connected in another tab.');
      return;
    }

    // Request mic permission before joining room
    resetLocalAudioPromise();
    try {
      await initLocalAudio(useStore.getState().audioInputDeviceId);
    } catch {
      useStore.getState().addToast('Could not access microphone — voice chat won\'t work.');
    }

    if (inviteToken && invitePassword) {
      setStorePassword(invitePassword);
      sessionStorage.setItem('qvoch-password', invitePassword);
      send('join', {
        username: username.trim(),
        inviteToken: inviteToken,
      });
    } else {
      if (!channelName.trim() || !password.trim()) return;
      setStorePassword(password);
      sessionStorage.setItem('qvoch-password', password);
      send('join', {
        username: username.trim(),
        channelName: channelName.trim(),
        password: password,
      });
    }

    useStore.setState({ username: username.trim() });
  };

  const isInviteLink = inviteToken !== null;

  if (autoRejoining) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg-primary">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-accent animate-spin" />
          <span className="text-text-secondary text-sm">Reconnecting to your channel...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-primary">
      <div className="w-full max-w-md p-8">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-3 mb-2">
            <Headphones className="w-10 h-10 text-accent" />
            <h1 className="text-4xl font-bold text-text-primary">QVoCh</h1>
          </div>
          <p className="text-text-secondary text-sm">Quick Voice Channel</p>
        </div>

        {isInviteLink ? (
          <div className="bg-bg-secondary rounded-lg p-6 border border-border">
            <h2 className="text-lg font-semibold mb-4 text-text-primary">
              You've been invited!
            </h2>
            <form onSubmit={handleJoin} className="space-y-4">
              <div>
                <label className="block text-sm text-text-secondary mb-1">
                  Display Name
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  maxLength={24}
                  placeholder="Enter your name"
                  className="w-full px-3 py-2 bg-bg-input border border-border rounded-md text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
                  autoFocus
                />
              </div>
              <button
                type="submit"
                disabled={!username.trim()}
                className="w-full py-2 bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-md transition-colors flex items-center justify-center gap-2"
              >
                <LogIn className="w-4 h-4" />
                Join Channel
              </button>
            </form>
          </div>
        ) : (
          <>
            <div className="flex mb-4">
              <button
                onClick={() => setTab('create')}
                className={`flex-1 py-2 text-sm font-medium border-b-2 transition-colors ${
                  tab === 'create'
                    ? 'border-accent text-accent'
                    : 'border-border text-text-secondary hover:text-text-primary'
                }`}
              >
                Create Channel
              </button>
              <button
                onClick={() => setTab('join')}
                className={`flex-1 py-2 text-sm font-medium border-b-2 transition-colors ${
                  tab === 'join'
                    ? 'border-accent text-accent'
                    : 'border-border text-text-secondary hover:text-text-primary'
                }`}
              >
                Join Channel
              </button>
            </div>

            <div className="bg-bg-secondary rounded-lg p-6 border border-border">
              {tab === 'create' ? (
                <form onSubmit={handleCreate} className="space-y-4">
                  <div>
                    <label className="block text-sm text-text-secondary mb-1">
                      Display Name
                    </label>
                    <input
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      maxLength={24}
                      placeholder="Enter your name"
                      className="w-full px-3 py-2 bg-bg-input border border-border rounded-md text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-text-secondary mb-1">
                      Channel Name
                    </label>
                    <input
                      type="text"
                      value={channelName}
                      onChange={(e) => setChannelName(e.target.value)}
                      maxLength={30}
                      placeholder="e.g. Lobby"
                      className="w-full px-3 py-2 bg-bg-input border border-border rounded-md text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-text-secondary mb-1">
                      Password
                    </label>
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      maxLength={64}
                      placeholder="Min 6 characters, used for E2E encryption"
                      className="w-full px-3 py-2 bg-bg-input border border-border rounded-md text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={
                      !username.trim() || !channelName.trim() || !password.trim()
                    }
                    className="w-full py-2 bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-md transition-colors flex items-center justify-center gap-2"
                  >
                    <Plus className="w-4 h-4" />
                    Create Channel
                  </button>
                </form>
              ) : (
                <form onSubmit={handleJoin} className="space-y-4">
                  <div>
                    <label className="block text-sm text-text-secondary mb-1">
                      Display Name
                    </label>
                    <input
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      maxLength={24}
                      placeholder="Enter your name"
                      className="w-full px-3 py-2 bg-bg-input border border-border rounded-md text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-text-secondary mb-1">
                      Channel Name (with code)
                    </label>
                    <input
                      type="text"
                      value={channelName}
                      onChange={(e) => setChannelName(e.target.value)}
                      placeholder="e.g. Lobby#4821"
                      className="w-full px-3 py-2 bg-bg-input border border-border rounded-md text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-text-secondary mb-1">
                      Password
                    </label>
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      maxLength={64}
                      placeholder="Room password"
                      className="w-full px-3 py-2 bg-bg-input border border-border rounded-md text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={
                      !username.trim() || !channelName.trim() || !password.trim()
                    }
                    className="w-full py-2 bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-md transition-colors flex items-center justify-center gap-2"
                  >
                    <LogIn className="w-4 h-4" />
                    Join Channel
                  </button>
                </form>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
