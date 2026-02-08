import { useState, useEffect, useCallback } from 'react';
import { useStore } from '../stores/useStore';
import { connect, send, isOtherTabActive } from '../services/socket';
import { initLocalAudio, resetLocalAudioPromise } from '../services/webrtc';
import { decodePasswordFromLink } from '../services/crypto';
import { Headphones, LogIn, Plus, Loader2, AlertTriangle } from 'lucide-react';
import { AppBuildFooter } from './AppBuildFooter';

type Tab = 'create' | 'join';

const REJOIN_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const REJOIN_KEYS = [
  'sessionToken',
  'qvoch-session-token',
  'qvoch-session-time',
  'qvoch-session-username',
  'qvoch-session-invite',
] as const;

interface InitialInviteState {
  tab: Tab;
  inviteToken: string | null;
  invitePassword: string | null;
}

interface RejoinTarget {
  username: string;
  sessionToken: string | null;
  inviteToken: string | null;
}

function clearRejoinState(): void {
  for (const key of REJOIN_KEYS) {
    localStorage.removeItem(key);
  }
}

function getInitialInviteState(): InitialInviteState {
  if (typeof window === 'undefined') {
    return { tab: 'create', inviteToken: null, invitePassword: null };
  }

  const match = window.location.hash.match(/#\/join\/([^/]+)\/(.+)/);
  if (!match) {
    return { tab: 'create', inviteToken: null, invitePassword: null };
  }

  const token = match[1];
  const encodedPw = match[2];

  try {
    const pw = decodePasswordFromLink(encodedPw);
    return {
      tab: 'join',
      inviteToken: token,
      invitePassword: pw,
    };
  } catch {
    console.error('Failed to decode invite link');
    return { tab: 'create', inviteToken: null, invitePassword: null };
  }
}

export function LandingPage() {
  const [initialInviteState] = useState<InitialInviteState>(() => getInitialInviteState());

  const [tab, setTab] = useState<Tab>(initialInviteState.tab);
  const [username, setUsername] = useState('');
  const [channelName, setChannelName] = useState('');
  const [password, setPassword] = useState('');
  const [inviteToken] = useState<string | null>(initialInviteState.inviteToken);
  const [invitePassword] = useState<string | null>(initialInviteState.invitePassword);
  const [rejoinTarget, setRejoinTarget] = useState<RejoinTarget | null>(null);
  const [otherTabActive, setOtherTabActive] = useState(false);
  const autoRejoining = rejoinTarget !== null;

  const setStorePassword = useStore((s) => s.setPassword);
  const connected = useStore((s) => s.connected);

  const refreshOtherTabState = useCallback(async (): Promise<boolean> => {
    const active = await isOtherTabActive();
    setOtherTabActive(active);
    return active;
  }, []);

  useEffect(() => {
    connect();
  }, []);

  useEffect(() => {
    let mounted = true;

    const probe = async () => {
      const active = await isOtherTabActive();
      if (!mounted) return;
      setOtherTabActive(active);
    };

    void probe();
    const interval = window.setInterval(() => {
      void probe();
    }, 2500);

    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
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
        setOtherTabActive(true);
        clearRejoinState();
        return;
      }
      setOtherTabActive(false);
      setRejoinTarget({
        username: sessionUsername,
        sessionToken,
        inviteToken: sessionInvite,
      });
      useStore.setState({ username: sessionUsername });
    });
  }, []);

  useEffect(() => {
    if (!rejoinTarget || !connected) return;

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
        if (rejoinTarget.sessionToken) {
          send('join', {
            username: rejoinTarget.username,
            sessionToken: rejoinTarget.sessionToken,
          });
          if (rejoinTarget.inviteToken) {
            fallbackTimer = setTimeout(() => {
              if (!useStore.getState().roomId) {
                send('join', {
                  username: rejoinTarget.username,
                  inviteToken: rejoinTarget.inviteToken ?? undefined,
                });
              }
            }, 2500);
          }
        } else if (rejoinTarget.inviteToken) {
          send('join', {
            username: rejoinTarget.username,
            inviteToken: rejoinTarget.inviteToken,
          });
        }
      });

    const timeout = setTimeout(() => {
      setRejoinTarget(null);
      if (!useStore.getState().roomId) {
        clearRejoinState();
      }
    }, 8000);

    return () => {
      clearTimeout(timeout);
      if (fallbackTimer) clearTimeout(fallbackTimer);
    };
  }, [rejoinTarget, connected]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !channelName.trim() || password.length < 6) return;

    if (await isOtherTabActive()) {
      setOtherTabActive(true);
      return;
    }
    setOtherTabActive(false);

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
      setOtherTabActive(true);
      return;
    }
    setOtherTabActive(false);

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

  if (otherTabActive) {
    return (
      <div className="min-h-screen bg-bg-primary flex flex-col">
        <div className="flex-1 flex items-center justify-center px-4">
          <div className="w-full max-w-md bg-bg-secondary border border-border rounded-xl p-6">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-full bg-accent/20 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-4 h-4 text-accent" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-text-primary">Already Active In Another Tab</h2>
                <p className="text-sm text-text-secondary mt-1">
                  This account is currently connected in another browser tab. Close that tab or leave the channel there, then try again here.
                </p>
              </div>
            </div>
            <button
              onClick={() => { void refreshOtherTabState(); }}
              className="mt-5 w-full py-2 bg-accent hover:bg-accent-hover text-white font-medium rounded-md transition-colors"
            >
              I Closed The Other Tab
            </button>
          </div>
        </div>
        <AppBuildFooter className="pb-4" />
      </div>
    );
  }

  if (autoRejoining) {
    return (
      <div className="min-h-screen bg-bg-primary flex flex-col">
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 text-accent animate-spin" />
            <span className="text-text-secondary text-sm">Reconnecting to your channel...</span>
          </div>
        </div>
        <AppBuildFooter className="pb-4" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-primary flex flex-col">
      <div className="flex-1 flex items-center justify-center px-4 py-8">
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
      <AppBuildFooter className="pb-4" />
    </div>
  );
}
