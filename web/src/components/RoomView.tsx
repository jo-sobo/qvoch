import { useStore } from '../stores/useStore';
import { UserList } from './UserList';
import { ChatPanel } from './ChatPanel';
import { Controls } from './Controls';
import { InviteModal } from './InviteModal';
import { SettingsPanel } from './SettingsPanel';
import { encodePasswordForLink } from '../services/crypto';
import { Headphones, Wifi, WifiOff, Link2, Check, Users } from 'lucide-react';
import { useState, useRef, useCallback, useEffect } from 'react';

const MIN_PANEL = 200;
const MAX_PANEL = 500;
const DEFAULT_PANEL = 260;

export function RoomView() {
  const roomFullName = useStore((s) => s.roomFullName);
  const connected = useStore((s) => s.connected);
  const reconnecting = useStore((s) => s.reconnecting);
  const inviteToken = useStore((s) => s.inviteToken);
  const password = useStore((s) => s.password);
  const addToast = useStore((s) => s.addToast);
  const users = useStore((s) => s.users);
  const [copied, setCopied] = useState(false);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL);
  const dragging = useRef(false);

  const handleCopyLink = async () => {
    if (!inviteToken || !password) return;
    const encoded = encodePasswordForLink(password);
    const url = `${window.location.origin}/#/join/${inviteToken}/${encoded}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      addToast('Invite link copied to clipboard!');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      prompt('Copy this invite link:', url);
    }
  };

  const handleDividerMouseDown = useCallback(() => {
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const newWidth = Math.max(MIN_PANEL, Math.min(MAX_PANEL, e.clientX));
      setPanelWidth(newWidth);
    };
    const handleMouseUp = () => {
      if (dragging.current) {
        dragging.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  return (
    <div className="h-screen flex flex-col bg-bg-primary">
      {reconnecting && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-bg-secondary border border-border rounded-lg p-6 flex items-center gap-3">
            <WifiOff className="w-5 h-5 text-accent animate-pulse" />
            <span className="text-text-primary">Reconnecting...</span>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between px-5 py-2.5 bg-bg-secondary/80 border-b border-border/40">
        <div className="flex items-center gap-3">
          <Headphones className="w-5 h-5 text-accent" />
          <div>
            <h1 className="text-sm font-semibold text-text-primary leading-tight">
              {roomFullName}
            </h1>
            <div className="flex items-center gap-1 text-xs text-text-muted">
              <Users className="w-3 h-3" />
              <span>{users.length} online</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleCopyLink}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-accent/10 hover:bg-accent/20 border border-accent/20 rounded-md text-xs font-medium text-accent hover:text-accent-hover transition-colors"
            title="Copy invite link"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5" />
            ) : (
              <Link2 className="w-3.5 h-3.5" />
            )}
            Invite Link
          </button>

          <div className="flex items-center gap-1">
            {connected ? (
              <Wifi className="w-4 h-4 text-success" />
            ) : (
              <WifiOff className="w-4 h-4 text-red-400" />
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div
          className="flex flex-col bg-bg-secondary/50"
          style={{ width: panelWidth }}
        >
          <div className="flex-1 overflow-hidden">
            <UserList />
          </div>
          <Controls />
        </div>

        <div
          onMouseDown={handleDividerMouseDown}
          className="w-px bg-border/30 hover:bg-accent/50 hover:w-0.5 cursor-col-resize transition-colors shrink-0"
        />

        <div className="flex-1 flex flex-col min-w-0">
          <ChatPanel />
        </div>
      </div>

      <InviteModal />
      <SettingsPanel />
    </div>
  );
}
