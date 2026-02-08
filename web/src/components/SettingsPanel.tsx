import { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../stores/useStore';
import { switchAudioInput, setOutputMuted, setOutputDevice, setLocalVolumeCallback } from '../services/webrtc';
import { X, Sun, Moon, Mic, Volume2 } from 'lucide-react';

interface AudioDevice {
  deviceId: string;
  label: string;
}

export function SettingsPanel() {
  const settingsOpen = useStore((s) => s.settingsOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const outputMuted = useStore((s) => s.outputMuted);
  const storeSetOutputMuted = useStore((s) => s.setOutputMuted);
  const audioInputDeviceId = useStore((s) => s.audioInputDeviceId);
  const setAudioInputDeviceId = useStore((s) => s.setAudioInputDeviceId);
  const audioOutputDeviceId = useStore((s) => s.audioOutputDeviceId);
  const setAudioOutputDeviceId = useStore((s) => s.setAudioOutputDeviceId);
  const voiceMode = useStore((s) => s.voiceMode);
  const setVoiceMode = useStore((s) => s.setVoiceMode);
  const vadThreshold = useStore((s) => s.vadThreshold);
  const setVadThreshold = useStore((s) => s.setVadThreshold);

  const [inputDevices, setInputDevices] = useState<AudioDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioDevice[]>([]);
  const [inputVolume, setInputVolume] = useState(0);

  useEffect(() => {
    if (!settingsOpen) return;

    async function loadDevices() {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        setInputDevices(
          devices
            .filter((d) => d.kind === 'audioinput')
            .map((d) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${d.deviceId.slice(0, 8)}` }))
        );
        setOutputDevices(
          devices
            .filter((d) => d.kind === 'audiooutput')
            .map((d) => ({ deviceId: d.deviceId, label: d.label || `Speaker ${d.deviceId.slice(0, 8)}` }))
        );
      } catch {
        // Device enumeration may fail until permissions are granted.
      }
    }

    loadDevices();
  }, [settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) {
      setLocalVolumeCallback(null);
      return;
    }

    setLocalVolumeCallback((vol) => setInputVolume(vol));
    return () => setLocalVolumeCallback(null);
  }, [settingsOpen]);

  const handleInputDeviceChange = useCallback(async (deviceId: string) => {
    setAudioInputDeviceId(deviceId);
    try {
      await switchAudioInput(deviceId);
    } catch (err) {
      console.error('Failed to switch audio input:', err);
    }
  }, [setAudioInputDeviceId]);

  const handleOutputDeviceChange = useCallback((deviceId: string) => {
    setAudioOutputDeviceId(deviceId);
    setOutputDevice(deviceId);
  }, [setAudioOutputDeviceId]);

  const handleOutputMuteToggle = useCallback(() => {
    const newMuted = !outputMuted;
    storeSetOutputMuted(newMuted);
    setOutputMuted(newMuted);
  }, [outputMuted, storeSetOutputMuted]);

  if (!settingsOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setSettingsOpen(false)}>
      <div
        className="bg-bg-secondary border border-border rounded-lg w-full max-w-md max-h-[80dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-text-primary">Settings</h2>
          <button onClick={() => setSettingsOpen(false)} className="text-text-muted hover:text-text-primary transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-6">
          <section>
            <h3 className="text-sm font-medium text-text-secondary mb-3">Appearance</h3>
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-primary">Theme</span>
              <div className="flex items-center gap-2 bg-bg-tertiary rounded-md p-1">
                <button
                  onClick={() => setTheme('dark')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                    theme === 'dark' ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'
                  }`}
                >
                  <Moon className="w-3.5 h-3.5" /> Dark
                </button>
                <button
                  onClick={() => setTheme('light')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                    theme === 'light' ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'
                  }`}
                >
                  <Sun className="w-3.5 h-3.5" /> Light
                </button>
              </div>
            </div>
          </section>

          <section>
            <h3 className="text-sm font-medium text-text-secondary mb-3 flex items-center gap-2">
              <Mic className="w-4 h-4" /> Audio Input
            </h3>
            <select
              value={audioInputDeviceId || ''}
              onChange={(e) => handleInputDeviceChange(e.target.value)}
              className="w-full px-3 py-2 bg-bg-input border border-border rounded-md text-sm text-text-primary focus:outline-none focus:border-accent"
            >
              <option value="">Default</option>
              {inputDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
              ))}
            </select>
            <CombinedVADBar
              inputVolume={inputVolume}
              voiceMode={voiceMode}
              vadThreshold={vadThreshold}
              setVadThreshold={setVadThreshold}
            />
          </section>

          <section>
            <h3 className="text-sm font-medium text-text-secondary mb-3 flex items-center gap-2">
              <Volume2 className="w-4 h-4" /> Audio Output
            </h3>
            {outputDevices.length > 0 && (
              <select
                value={audioOutputDeviceId || ''}
                onChange={(e) => handleOutputDeviceChange(e.target.value)}
                className="w-full px-3 py-2 bg-bg-input border border-border rounded-md text-sm text-text-primary focus:outline-none focus:border-accent"
              >
                <option value="">Default</option>
                {outputDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
                ))}
              </select>
            )}
            <div className="mt-3 flex items-center justify-between">
              <span className="text-sm text-text-primary">Mute Output</span>
              <button
                onClick={handleOutputMuteToggle}
                className={`relative w-10 h-5 rounded-full transition-colors ${
                  outputMuted ? 'bg-red-500/40' : 'bg-bg-tertiary'
                }`}
              >
                <div
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                    outputMuted ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
          </section>

          <section>
            <h3 className="text-sm font-medium text-text-secondary mb-3">Voice Mode</h3>
            <div className="flex items-center gap-2 bg-bg-tertiary rounded-md p-1">
              <button
                onClick={() => setVoiceMode('vad')}
                className={`flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                  voiceMode === 'vad' ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'
                }`}
              >
                Voice Activation
              </button>
              <button
                onClick={() => setVoiceMode('ptt')}
                className={`flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                  voiceMode === 'ptt' ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'
                }`}
              >
                Push to Talk
              </button>
            </div>

            {voiceMode === 'ptt' && (
              <p className="text-xs text-text-muted mt-3">
                Hold <kbd className="px-1.5 py-0.5 bg-bg-tertiary border border-border rounded text-text-secondary">Space</kbd> to talk
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function CombinedVADBar({
  inputVolume,
  voiceMode,
  vadThreshold,
  setVadThreshold,
}: {
  inputVolume: number;
  voiceMode: 'vad' | 'ptt';
  vadThreshold: number;
  setVadThreshold: (v: number) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const volumePct = Math.min(100, (inputVolume / 128) * 100);
  const isSpeaking = voiceMode === 'vad' && volumePct > vadThreshold;

  const handlePointerDown = (e: React.PointerEvent) => {
    if (voiceMode !== 'vad') return;
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    updateThreshold(e.clientX);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    updateThreshold(e.clientX);
  };

  const handlePointerUp = () => {
    dragging.current = false;
  };

  const updateThreshold = (clientX: number) => {
    if (!barRef.current) return;
    const rect = barRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
    setVadThreshold(Math.round(pct));
  };

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-text-muted">
          {voiceMode === 'vad' ? 'Input Level & Threshold' : 'Input Level'}
        </span>
        {isSpeaking && (
          <span className="text-xs text-success font-medium">Speaking</span>
        )}
      </div>
      <div
        ref={barRef}
        className="relative h-4 bg-bg-tertiary rounded-full overflow-visible cursor-pointer select-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <div
          className={`absolute inset-y-0 left-0 rounded-full transition-all duration-75 ${
            isSpeaking ? 'bg-success/70' : 'bg-text-muted/30'
          }`}
          style={{ width: `${volumePct}%` }}
        />

        {voiceMode === 'vad' && (
          <div
            className="absolute top-0 h-full"
            style={{ left: `${vadThreshold}%`, transform: 'translateX(-50%)' }}
          >
            <div className="w-0.5 h-full bg-accent shadow-[0_0_0_1px_rgba(14,165,233,0.2)]" />
          </div>
        )}
      </div>
      {voiceMode === 'vad' && (
        <div className="text-xs text-text-muted mt-1 text-right">
          Threshold: {vadThreshold}
        </div>
      )}
    </div>
  );
}
