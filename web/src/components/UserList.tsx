import { useStore } from '../stores/useStore';
import { send } from '../services/socket';
import {
  setUserVolume as setWebRTCUserVolume,
  subscribeVolumeCallback,
  subscribeVoiceTransmissionCallback,
} from '../services/webrtc';
import { MicOff, Volume2, VolumeX } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';

interface ContextMenuState {
  x: number;
  y: number;
  userId: string;
}

function SubCountdownTimer({ expiresAt }: { expiresAt: number }) {
  const [remaining, setRemaining] = useState(() => Math.max(0, expiresAt - Date.now()));

  useEffect(() => {
    const update = () => setRemaining(Math.max(0, expiresAt - Date.now()));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  if (remaining <= 0) return null;

  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  const progress = (remaining / (5 * 60 * 1000)) * 100;

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1 bg-bg-tertiary rounded-full overflow-hidden">
        <div
          className="h-full bg-accent/40 rounded-full transition-all duration-1000"
          style={{ width: `${progress}%` }}
        />
      </div>
      <span className="text-xs text-accent font-mono whitespace-nowrap">
        {mins}:{secs.toString().padStart(2, '0')}
      </span>
    </div>
  );
}

export function UserList() {
  const users = useStore((s) => s.users);
  const subChannels = useStore((s) => s.subChannels);
  const currentChannelId = useStore((s) => s.currentChannelId);
  const roomId = useStore((s) => s.roomId);
  const myUserId = useStore((s) => s.userId);
  const outputMuted = useStore((s) => s.outputMuted);
  const userVolumes = useStore((s) => s.userVolumes);
  const storeSetUserVolume = useStore((s) => s.setUserVolume);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [inviteNameInput, setInviteNameInput] = useState(false);
  const [channelName, setChannelName] = useState('');
  const [talkingUsers, setTalkingUsers] = useState<Record<string, boolean>>({});
  const [localTalking, setLocalTalking] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  const recentSpeechAt = useRef<Record<string, number>>({});

  useEffect(() => {
    const handler = () => {
      setContextMenu(null);
      setInviteNameInput(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeVolumeCallback((volumes) => {
      const now = performance.now();
      const speakingThreshold = 18;
      const holdMs = 240;

      for (const [streamId, level] of volumes) {
        if (!streamId.startsWith('stream-')) continue;
        const userId = streamId.slice(7);
        if (level >= speakingThreshold) {
          recentSpeechAt.current[userId] = now;
        }
      }

      const nextTalking: Record<string, boolean> = {};
      for (const [userId, ts] of Object.entries(recentSpeechAt.current)) {
        if (now - ts <= holdMs) {
          nextTalking[userId] = true;
        } else {
          delete recentSpeechAt.current[userId];
        }
      }

      setTalkingUsers((prev) => {
        const prevIds = Object.keys(prev);
        const nextIds = Object.keys(nextTalking);
        if (prevIds.length === nextIds.length && nextIds.every((id) => prev[id])) {
          return prev;
        }
        return nextTalking;
      });
    });

    return () => {
      unsubscribe();
      recentSpeechAt.current = {};
      setTalkingUsers({});
    };
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeVoiceTransmissionCallback((active) => {
      setLocalTalking((prev) => (prev === active ? prev : active));
    });
    return () => unsubscribe();
  }, []);

  const mainChannelUsers = users.filter((u) => !u.inSubChannel);
  const isInMainChannel = currentChannelId === roomId;

  const handleContextMenu = (e: React.MouseEvent, userId: string) => {
    e.preventDefault();
    if (userId === myUserId) return;
    openContextMenu(e.clientX, e.clientY, userId);
    setInviteNameInput(false);
    setChannelName('');
  };

  const openContextMenu = (x: number, y: number, userId: string) => {
    const menuWidth = 200;
    const menuHeight = 150;
    const clampedX = Math.min(Math.max(8, x), window.innerWidth - menuWidth - 8);
    const clampedY = Math.min(Math.max(8, y), window.innerHeight - menuHeight - 8);
    setContextMenu({ x: clampedX, y: clampedY, userId });
  };

  const handleTouchStart = (e: React.TouchEvent, userId: string) => {
    if (userId === myUserId) return;
    const touch = e.touches[0];
    touchStartPos.current = { x: touch.clientX, y: touch.clientY };
    longPressTimer.current = setTimeout(() => {
      openContextMenu(touch.clientX, touch.clientY, userId);
      longPressTimer.current = null;
    }, 500);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!longPressTimer.current || !touchStartPos.current) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartPos.current.x;
    const dy = touch.clientY - touchStartPos.current.y;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const handleTouchEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    touchStartPos.current = null;
  };

  const handleInviteToSub = () => {
    if (!contextMenu) return;
    setInviteNameInput(true);
  };

  const handleSendInvite = (e: React.FormEvent) => {
    e.preventDefault();
    if (!contextMenu) return;
    send('sub-invite', {
      targetUserId: contextMenu.userId,
      channelName: channelName.trim() || undefined,
    });
    setContextMenu(null);
    setInviteNameInput(false);
    setChannelName('');
  };

  const handleMainChannelClick = () => {
    if (!isInMainChannel) {
      send('move-to-main', {});
    }
  };

  const handleSubChannelClick = (subId: string) => {
    if (currentChannelId === subId) return;
    send('move-to-sub', { subChannelId: subId });
  };

  const handleVolumeChange = (userId: string, volume: number) => {
    storeSetUserVolume(userId, volume);
    setWebRTCUserVolume(userId, volume);
  };

  const contextTargetInMain = contextMenu
    ? users.find((u) => u.id === contextMenu.userId && !u.inSubChannel)
    : null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-2">
        <div className="mb-2">
          <div
            onClick={handleMainChannelClick}
            className={`px-2 py-1 text-xs font-semibold text-text-muted uppercase tracking-wider ${
              !isInMainChannel ? 'cursor-pointer hover:text-text-secondary hover:bg-bg-tertiary/20 rounded' : ''
            }`}
          >
            Main Channel
          </div>
          {mainChannelUsers.map((user) => {
            const isMe = user.id === myUserId;
            const userVolume = userVolumes[user.id] ?? 100;
            const speakerMuted = userVolume <= 0 || (isMe && outputMuted);
            const talking = isMe ? localTalking : (!user.muted && !!talkingUsers[user.id]);

            return (
              <div
                key={user.id}
                onContextMenu={(e) => handleContextMenu(e, user.id)}
                onTouchStart={(e) => handleTouchStart(e, user.id)}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                onTouchCancel={handleTouchEnd}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-bg-tertiary/30 cursor-default ${
                  isMe ? 'bg-bg-tertiary/20' : ''
                }`}
              >
                <div className="flex items-center gap-1 min-w-4">
                  <span
                    className={`w-2.5 h-2.5 rounded-full transition-all ${
                      talking ? 'bg-speaking animate-pulse' : 'bg-text-muted/60'
                    }`}
                    style={{
                      boxShadow: talking
                        ? '0 0 0 3px rgba(34,197,94,0.2)'
                        : '0 0 0 2px rgba(90,90,110,0.22)',
                    }}
                    title={talking ? 'Talking' : 'Not talking'}
                  />
                  {user.muted && <MicOff className="w-4 h-4 text-text-muted" />}
                  {speakerMuted && <VolumeX className="w-4 h-4 text-text-muted" />}
                </div>
                <span className="flex-1 min-w-0 text-sm text-text-primary truncate">
                  {user.name}
                  {isMe && (
                    <span className="text-text-muted ml-1">(you)</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>

        {subChannels.map((sub) => {
          const isCurrentSub = currentChannelId === sub.id;

          return (
            <div key={sub.id} className="mb-2">
              <div
                onClick={() => !isCurrentSub && handleSubChannelClick(sub.id)}
                className={`px-2 py-1 rounded ${
                  !isCurrentSub
                    ? 'cursor-pointer hover:bg-bg-tertiary/20'
                    : ''
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className={`text-xs font-semibold uppercase tracking-wider ${
                    isCurrentSub ? 'text-accent' : 'text-text-muted hover:text-text-secondary'
                  }`}>
                    {sub.name || 'Private'}
                  </span>
                </div>
                {sub.expiresAt && (
                  <div className="mt-1">
                    <SubCountdownTimer expiresAt={sub.expiresAt} />
                  </div>
                )}
              </div>
              {sub.users.map((user) => {
                const isMe = user.id === myUserId;
                const userVolume = userVolumes[user.id] ?? 100;
                const speakerMuted = userVolume <= 0 || (isMe && outputMuted);
                const talking = isMe ? localTalking : (!user.muted && !!talkingUsers[user.id]);

                return (
                  <div
                    key={user.id}
                    onContextMenu={(e) => handleContextMenu(e, user.id)}
                    onTouchStart={(e) => handleTouchStart(e, user.id)}
                    onTouchMove={handleTouchMove}
                    onTouchEnd={handleTouchEnd}
                    onTouchCancel={handleTouchEnd}
                    className={`flex items-center gap-2 px-4 py-1.5 rounded-md ${
                      isMe ? 'bg-bg-tertiary/20' : ''
                    }`}
                  >
                    <div className="flex items-center gap-1 min-w-4">
                      <span
                        className={`w-2 h-2 rounded-full transition-all ${
                          talking ? 'bg-speaking animate-pulse' : 'bg-text-muted/60'
                        }`}
                        style={{
                          boxShadow: talking
                            ? '0 0 0 3px rgba(34,197,94,0.2)'
                            : '0 0 0 2px rgba(90,90,110,0.22)',
                        }}
                        title={talking ? 'Talking' : 'Not talking'}
                      />
                      {user.muted && <MicOff className="w-3.5 h-3.5 text-text-muted" />}
                      {speakerMuted && <VolumeX className="w-3.5 h-3.5 text-text-muted" />}
                    </div>
                    <span className="flex-1 min-w-0 text-sm text-text-secondary truncate">
                      {user.name}
                      {isMe && (
                        <span className="text-text-muted ml-1">(you)</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed bg-bg-secondary border border-border rounded-md shadow-lg z-40 py-1 min-w-45"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-2 border-b border-border/50">
            <div className="flex items-center gap-2 mb-1">
              <Volume2 className="w-3.5 h-3.5 text-text-muted" />
              <span className="text-xs text-text-secondary">
                Volume: {userVolumes[contextMenu.userId] ?? 100}%
              </span>
            </div>
            <input
              type="range"
              min="0"
              max="150"
              value={userVolumes[contextMenu.userId] ?? 100}
              onChange={(e) => handleVolumeChange(contextMenu.userId, Number(e.target.value))}
              className="w-full accent-accent h-1"
            />
          </div>

          {isInMainChannel && contextTargetInMain && (
            <>
              {!inviteNameInput ? (
                <button
                  onClick={handleInviteToSub}
                  className="w-full px-4 py-2 text-sm text-text-primary hover:bg-bg-tertiary text-left"
                >
                  Invite to Private Channel
                </button>
              ) : (
                <form onSubmit={handleSendInvite} className="p-2 space-y-2">
                  <input
                    type="text"
                    value={channelName}
                    onChange={(e) => setChannelName(e.target.value)}
                    placeholder="Channel name (optional)"
                    maxLength={30}
                    autoFocus
                    className="w-full px-2 py-1 bg-bg-input border border-border rounded text-xs text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
                  />
                  <button
                    type="submit"
                    className="w-full px-3 py-1 bg-accent hover:bg-accent-hover text-white rounded text-xs font-medium"
                  >
                    Send Invite
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
