import { useStore } from '../stores/useStore';
import { UserList } from './UserList';
import { ChatPanel } from './ChatPanel';
import { Controls } from './Controls';
import { InviteModal } from './InviteModal';
import { SettingsPanel } from './SettingsPanel';
import { encodePasswordForLink } from '../services/crypto';
import { Headphones, Wifi, WifiOff, Link2, Check, Users, MessageSquare, AlertTriangle } from 'lucide-react';
import { useState, useRef, useCallback, useEffect } from 'react';

const MIN_PANEL = 200;
const MAX_PANEL = 500;
const DEFAULT_PANEL = 260;

type MobileTab = 'users' | 'chat';

export function RoomView() {
  const roomFullName = useStore((s) => s.roomFullName);
  const connected = useStore((s) => s.connected);
  const reconnecting = useStore((s) => s.reconnecting);
  const inviteToken = useStore((s) => s.inviteToken);
  const password = useStore((s) => s.password);
  const addToast = useStore((s) => s.addToast);
  const users = useStore((s) => s.users);
  const webrtcUnavailable = useStore((s) => s.webrtcUnavailable);
  const [copied, setCopied] = useState(false);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL);
  const [mobileTab, setMobileTab] = useState<MobileTab>('users');
  const dragging = useRef(false);

  const handleCopyLink = async () => {
    if (!inviteToken || !password) return;
    const encoded = encodePasswordForLink(password);
    const url = `${window.location.origin}/invite/${inviteToken}/${encoded}`;
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
    <div className="h-dvh flex flex-col bg-bg-primary">
      {reconnecting && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]">
          <div className="bg-bg-secondary border border-border rounded-lg p-6 flex items-center gap-3">
            <WifiOff className="w-5 h-5 text-accent animate-pulse" />
            <span className="text-text-primary">Reconnecting...</span>
          </div>
        </div>
      )}

      {webrtcUnavailable && (
        <div className="flex items-center gap-2 px-4 py-2 bg-yellow-900/40 border-b border-yellow-700/50 text-yellow-200 text-xs">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>
            WebRTC is disabled in your browser — voice chat will not work.{' '}
            <a
              href="https://webrtc.org/getting-started/testing"
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-yellow-100 hover:text-white"
            >
              Learn how to enable it
            </a>
          </span>
        </div>
      )}

      <div className="grid grid-cols-[1fr_auto_1fr] items-center px-5 py-2.5 bg-bg-secondary/80 border-b border-border/40 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Headphones className="w-5 h-5 text-accent" />
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-text-primary leading-tight">
              {roomFullName}
            </h1>
            <div className="flex items-center gap-1 text-xs text-text-muted">
              <Users className="w-3 h-3" />
              <span>{users.length} online</span>
            </div>
          </div>
        </div>

        <div className="justify-self-center">
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
            <span className="hidden sm:inline">Invite Link</span>
          </button>
        </div>

        <div className="justify-self-end flex items-center gap-1">
          {connected ? (
            <Wifi className="w-4 h-4 text-success" />
          ) : (
            <WifiOff className="w-4 h-4 text-red-400" />
          )}
        </div>
      </div>

      {/* Mobile tab bar - visible only on small screens */}
      <div className="flex md:hidden border-b border-border/40 bg-bg-secondary/50">
        <button
          onClick={() => setMobileTab('users')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors ${
            mobileTab === 'users'
              ? 'text-accent border-b-2 border-accent'
              : 'text-text-secondary'
          }`}
        >
          <Users className="w-3.5 h-3.5" />
          Voice ({users.length})
        </button>
        <button
          onClick={() => setMobileTab('chat')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors ${
            mobileTab === 'chat'
              ? 'text-accent border-b-2 border-accent'
              : 'text-text-secondary'
          }`}
        >
          <MessageSquare className="w-3.5 h-3.5" />
          Chat
        </button>
      </div>

      {/* Desktop layout: side-by-side */}
      <div className="flex-1 hidden md:flex overflow-hidden">
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
          className="relative w-8 -mx-4 shrink-0 cursor-col-resize group touch-none z-10"
        >
          <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-border/30 group-hover:bg-accent/50 transition-colors pointer-events-none" />
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-11 w-1.5 rounded-full bg-border/70 group-hover:bg-accent/80 transition-colors pointer-events-none" />
        </div>

        <div className="flex-1 flex flex-col min-w-0">
          <ChatPanel />
        </div>
      </div>

      {/* Mobile layout: tab-switched panels */}
      <div className="flex-1 flex flex-col md:hidden overflow-hidden">
        {mobileTab === 'users' ? (
          <>
            <div className="flex-1 overflow-hidden bg-bg-secondary/50">
              <UserList />
            </div>
            <Controls />
          </>
        ) : (
          <ChatPanel />
        )}
      </div>

      <InviteModal />
      <SettingsPanel />
    </div>
  );
}
