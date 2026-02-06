import { useState, useEffect } from 'react';
import { useStore } from './stores/useStore';
import { LandingPage } from './components/LandingPage';
import { RoomView } from './components/RoomView';
import { ToastContainer } from './components/Toast';
import { persistSessionForRejoin } from './services/socket';

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
