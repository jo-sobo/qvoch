import { useState, useEffect } from 'react';
import { useStore } from './stores/useStore';
import { LandingPage } from './components/LandingPage';
import { RoomView } from './components/RoomView';
import { ToastContainer } from './components/Toast';
import { connect, persistSessionForRejoin } from './services/socket';
import { ensureAudioContext } from './services/webrtc';

type View = 'landing' | 'room';

function App() {
  const [view, setView] = useState<View>('landing');
  const roomId = useStore((s) => s.roomId);

  const theme = useStore((s) => s.theme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!roomId) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      persistSessionForRejoin();
      e.preventDefault();
      e.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
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
      const hash = window.location.hash;
      if (hash.startsWith('#/room/') && roomId) {
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
    if (roomId) {
      setView('room');
    }
  }, [roomId]);

  return (
    <>
      {view === 'room' ? <RoomView /> : <LandingPage />}
      <ToastContainer />
    </>
  );
}

export default App;
