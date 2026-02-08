import { useStore } from '../stores/useStore';
import { send, leaveRoomAndReset } from '../services/socket';
import { setMuted as setWebRTCMuted, setOutputMuted as setWebRTCOutputMuted } from '../services/webrtc';
import { Mic, MicOff, LogOut, ArrowLeft, Settings, Headphones, HeadphoneOff } from 'lucide-react';

export function Controls() {
  const muted = useStore((s) => s.muted);
  const setMuted = useStore((s) => s.setMuted);
  const outputMuted = useStore((s) => s.outputMuted);
  const storeSetOutputMuted = useStore((s) => s.setOutputMuted);
  const currentChannelId = useStore((s) => s.currentChannelId);
  const roomId = useStore((s) => s.roomId);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);

  const isInSubChannel = currentChannelId !== roomId;

  const handleMuteToggle = () => {
    const newMuted = !muted;
    setMuted(newMuted);
    setWebRTCMuted(newMuted);
    send('mute', { muted: newMuted });
  };

  const handleOutputMuteToggle = () => {
    const newMuted = !outputMuted;
    storeSetOutputMuted(newMuted);
    setWebRTCOutputMuted(newMuted);
  };

  const handleLeave = () => {
    leaveRoomAndReset();
  };

  const handleReturnToMain = () => {
    send('move-to-main', {});
  };

  return (
    <div className="p-3 border-border space-y-2">
      {isInSubChannel && (
        <button
          onClick={handleReturnToMain}
          className="w-full py-2 px-3 bg-bg-tertiary hover:bg-bg-tertiary/80 rounded-md text-sm text-text-primary transition-colors flex items-center justify-center gap-2"
        >
          <ArrowLeft className="w-4 h-4" />
          Return to Main
        </button>
      )}

      <div className="flex gap-2">
        <button
          onClick={handleMuteToggle}
          className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
            muted
              ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
              : 'bg-success/20 text-success hover:bg-success/30'
          }`}
        >
          {muted ? (
            <>
              <MicOff className="w-4 h-4" />
            </>
          ) : (
            <>
              <Mic className="w-4 h-4" />
            </>
          )}
        </button>

        <button
          onClick={handleOutputMuteToggle}
          className={`py-2 px-3 rounded-md text-sm transition-colors flex items-center gap-1 ${
            outputMuted
              ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
              : 'bg-bg-tertiary hover:bg-bg-tertiary/80 text-text-secondary'
          }`}
          title={outputMuted ? 'Unmute output' : 'Mute output'}
        >
          {outputMuted ? (
            <HeadphoneOff className="w-4 h-4" />
          ) : (
            <Headphones className="w-4 h-4" />
          )}
        </button>

        <button
          onClick={() => setSettingsOpen(true)}
          className="py-2 px-3 bg-bg-tertiary hover:bg-bg-tertiary/80 rounded-md text-sm transition-colors flex items-center gap-1"
          title="Settings"
        >
          <Settings className="w-4 h-4 text-text-secondary" />
        </button>

        <button
          onClick={handleLeave}
          className="py-2 px-3 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-md text-sm transition-colors flex items-center gap-1"
          title="Leave channel"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
