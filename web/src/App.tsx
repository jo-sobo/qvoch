import { useState, useEffect, useRef } from 'react';
import { useStore } from './stores/useStore';
import { LandingPage } from './components/LandingPage';
import { RoomView } from './components/RoomView';
import { ToastContainer } from './components/Toast';
import { connect, persistSessionForRejoin, leaveRoomAndReset } from './services/socket';
import { ensureAudioContext, getLocalVolume, setVoiceTransmissionActive } from './services/webrtc';
import { AlertTriangle } from 'lucide-react';

type View = 'landing' | 'room';
type LeaveIntent = 'reload' | 'leave';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.closest('[contenteditable="true"]') !== null;
}

function App() {
  const [view, setView] = useState<View>('landing');
  const [leaveIntent, setLeaveIntent] = useState<LeaveIntent | null>(null);
  const roomId = useStore((s) => s.roomId);
  const pttPressedRef = useRef(false);
  const vadTalkingRef = useRef(false);
  const transmissionActiveRef = useRef(true);

  const theme = useStore((s) => s.theme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!roomId) return;

    const handleBeforeUnload = () => {
      persistSessionForRejoin();
    };
    const handlePageHide = () => {
      persistSessionForRejoin();
    };
    const handleHidden = () => {
      if (document.visibilityState === 'hidden') {
        persistSessionForRejoin();
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handlePageHide);
    document.addEventListener('visibilitychange', handleHidden);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handlePageHide);
      document.removeEventListener('visibilitychange', handleHidden);
    };
  }, [roomId]);

  useEffect(() => {
    if (!roomId) return;

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        ensureAudioContext();
        const store = useStore.getState();
        if (!store.connected) {
          connect();
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [roomId]);

  useEffect(() => {
    const handleHash = () => {
      const activeRoomId = useStore.getState().roomId;
      const hash = window.location.hash;
      const wantsRoom = hash.startsWith('#/room/');
      if (!wantsRoom && activeRoomId) {
        setLeaveIntent('leave');
        const roomHash = `#/room/${activeRoomId}`;
        window.history.pushState(window.history.state, '', roomHash);
        setView('room');
        return;
      }
      if (wantsRoom && activeRoomId) {
        setView('room');
      } else {
        setView('landing');
      }
    };

    handleHash();
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, [roomId]);

  useEffect(() => {
    if (!roomId) return;

    const handleReloadKeys = (e: KeyboardEvent) => {
      const isReloadShortcut = e.key === 'F5'
        || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r');
      if (!isReloadShortcut) return;
      e.preventDefault();
      setLeaveIntent('reload');
    };

    window.addEventListener('keydown', handleReloadKeys, true);
    return () => window.removeEventListener('keydown', handleReloadKeys, true);
  }, [roomId]);

  useEffect(() => {
    if (!roomId) return;

    const initialActive = false;
    transmissionActiveRef.current = initialActive;
    vadTalkingRef.current = false;
    pttPressedRef.current = false;
    setVoiceTransmissionActive(initialActive);

    let rafId: number | null = null;
    const loop = () => {
      const { voiceMode: mode, vadThreshold } = useStore.getState();
      let shouldTransmit = false;

      if (mode === 'ptt') {
        shouldTransmit = pttPressedRef.current;
        vadTalkingRef.current = false;
      } else {
        const volume = getLocalVolume();
        const volumePct = Math.min(100, (volume / 128) * 100);
        const onThreshold = Math.min(100, vadThreshold + 4);
        const offThreshold = Math.max(0, vadThreshold - 4);

        if (vadTalkingRef.current) {
          if (volumePct <= offThreshold) {
            vadTalkingRef.current = false;
          }
        } else if (volumePct >= onThreshold) {
          vadTalkingRef.current = true;
        }

        shouldTransmit = vadTalkingRef.current;
      }

      if (transmissionActiveRef.current !== shouldTransmit) {
        transmissionActiveRef.current = shouldTransmit;
        setVoiceTransmissionActive(shouldTransmit);
      }

      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);

    return () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      pttPressedRef.current = false;
      vadTalkingRef.current = false;
      transmissionActiveRef.current = true;
      setVoiceTransmissionActive(true);
    };
  }, [roomId]);

  useEffect(() => {
    if (!roomId) return;

    const releasePTT = () => {
      pttPressedRef.current = false;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      if (useStore.getState().voiceMode !== 'ptt') return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      pttPressedRef.current = true;
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      if (useStore.getState().voiceMode !== 'ptt') return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      pttPressedRef.current = false;
    };

    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') {
        releasePTT();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', releasePTT);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', releasePTT);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [roomId]);

  const handleLeaveConfirm = () => {
    if (!leaveIntent) return;
    if (leaveIntent === 'reload') {
      persistSessionForRejoin();
      setLeaveIntent(null);
      window.location.reload();
      return;
    }
    setLeaveIntent(null);
    leaveRoomAndReset();
  };

  const handleLeaveCancel = () => {
    setLeaveIntent(null);
    if (roomId) {
      window.history.replaceState(window.history.state, '', `#/room/${roomId}`);
    }
  };

  return (
    <>
      {view === 'room' ? <RoomView /> : <LandingPage />}
      <ToastContainer />
      {leaveIntent && (
        <div className="fixed inset-0 z-[60] bg-black/65 flex items-center justify-center px-4">
          <div className="w-full max-w-sm bg-bg-secondary border border-border rounded-xl shadow-xl p-5">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-full bg-accent/20 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-4 h-4 text-accent" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-text-primary">
                  {leaveIntent === 'reload' ? 'Reload Page?' : 'Leave Channel?'}
                </h2>
                <p className="text-xs text-text-secondary mt-1">
                  {leaveIntent === 'reload'
                    ? 'You can reload safely. Your session will reconnect automatically.'
                    : 'Leaving now disconnects you from the current channel.'}
                </p>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={handleLeaveCancel}
                className="px-3 py-1.5 rounded-md bg-bg-tertiary text-text-secondary hover:text-text-primary text-xs transition-colors"
              >
                Stay
              </button>
              <button
                onClick={handleLeaveConfirm}
                className="px-3 py-1.5 rounded-md bg-accent hover:bg-accent-hover text-white text-xs font-medium transition-colors"
              >
                {leaveIntent === 'reload' ? 'Reload' : 'Leave'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default App;
