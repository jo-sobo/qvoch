import { useState, useRef, useEffect, useCallback } from 'react';
import { useStore } from '../stores/useStore';
import { send } from '../services/socket';
import { encryptMessage } from '../services/crypto';
import { isGiphyConfigured } from '../services/giphy';
import { GifPicker } from './GifPicker';
import { LinkWarningModal } from './LinkWarningModal';
import { Send, MessageSquare, Smile, ImageIcon } from 'lucide-react';
import Picker from '@emoji-mart/react';
import data from '@emoji-mart/data';

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
const MENTION_REGEX = /@(\w+)/g;
const GIF_PREFIX = '[gif]';

export function ChatPanel() {
  const [message, setMessage] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [mentionFilter, setMentionFilter] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const currentChannelId = useStore((s) => s.currentChannelId);
  const chatMessages = useStore((s) => s.chatMessages);
  const myUserId = useStore((s) => s.userId);
  const myUsername = useStore((s) => s.username);
  const e2eKey = useStore((s) => s.e2eKey);
  const users = useStore((s) => s.users);
  const theme = useStore((s) => s.theme);

  const messages = currentChannelId ? chatMessages[currentChannelId] || [] : [];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const mentionSuggestions = mentionFilter !== null
    ? users
        .filter((u) => u.id !== myUserId && u.name.toLowerCase().startsWith(mentionFilter.toLowerCase()))
        .slice(0, 5)
    : [];

  const addToast = useStore((s) => s.addToast);

  const sendText = useCallback(async (text: string) => {
    if (!text || !e2eKey) return;
    try {
      const ciphertext = await encryptMessage(e2eKey, text);
      if (!send('chat', { ciphertext })) {
        addToast('Message not sent — reconnecting...');
      }
    } catch (err) {
      console.error('Failed to encrypt message:', err);
    }
  }, [e2eKey, addToast]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = message.trim();
    if (!text) return;
    await sendText(text);
    setMessage('');
    setMentionFilter(null);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setMessage(val);

    const cursorPos = e.target.selectionStart || val.length;
    const textBeforeCursor = val.substring(0, cursorPos);
    const mentionMatch = textBeforeCursor.match(/@(\w*)$/);
    if (mentionMatch) {
      setMentionFilter(mentionMatch[1]);
      setMentionIndex(0);
    } else {
      setMentionFilter(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (mentionFilter !== null && mentionSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => Math.min(i + 1, mentionSuggestions.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Tab' || e.key === 'Enter') {
        if (mentionSuggestions[mentionIndex]) {
          e.preventDefault();
          insertMention(mentionSuggestions[mentionIndex].name);
        }
      }
    }
  };

  const insertMention = (username: string) => {
    const cursorPos = inputRef.current?.selectionStart || message.length;
    const textBeforeCursor = message.substring(0, cursorPos);
    const textAfterCursor = message.substring(cursorPos);
    const newBefore = textBeforeCursor.replace(/@\w*$/, `@${username} `);
    setMessage(newBefore + textAfterCursor);
    setMentionFilter(null);
    inputRef.current?.focus();
  };

  const handleEmojiSelect = (emoji: { native: string }) => {
    setMessage((m) => m + emoji.native);
    setShowEmojiPicker(false);
    inputRef.current?.focus();
  };

  const handleGifSelect = async (gifUrl: string) => {
    setShowGifPicker(false);
    await sendText(`${GIF_PREFIX}${gifUrl}`);
  };

  const handleLinkClick = (e: React.MouseEvent, url: string) => {
    e.preventDefault();
    setPendingLink(url);
  };

  const handleLinkConfirm = () => {
    if (pendingLink) {
      window.open(pendingLink, '_blank', 'noopener,noreferrer');
    }
    setPendingLink(null);
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-3 border-border">
        <MessageSquare className="w-4 h-4 text-text-secondary" />
        <span className="text-sm font-medium text-text-secondary">Chat</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-text-muted text-sm mt-8">
            No messages yet. Start the conversation!
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`${msg.userId === myUserId ? 'ml-8' : 'mr-8'}`}
          >
            <div className="flex items-baseline gap-2 mb-0.5">
              <span
                className={`text-xs font-medium ${
                  msg.userId === myUserId ? 'text-accent' : 'text-text-secondary'
                }`}
              >
                {msg.userName}
              </span>
              <span className="text-xs text-text-muted">
                {formatTime(msg.timestamp)}
              </span>
            </div>
            <div
              className={`px-3 py-1.5 rounded-lg text-sm ${
                msg.userId === myUserId
                  ? 'bg-accent/20 text-text-primary'
                  : 'bg-bg-tertiary/40 text-text-primary'
              }`}
            >
              <MessageContent
                text={msg.plaintext || '[encrypted]'}
                myUsername={myUsername}
                onLinkClick={handleLinkClick}
              />
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="relative p-3 border-border">
        {mentionFilter !== null && mentionSuggestions.length > 0 && (
          <div className="absolute bottom-full left-3 mb-1 bg-bg-secondary border border-border rounded-md shadow-lg z-50 py-1 min-w-37.5">
            {mentionSuggestions.map((user, i) => (
              <button
                key={user.id}
                onClick={() => insertMention(user.name)}
                className={`w-full px-3 py-1.5 text-sm text-left ${
                  i === mentionIndex ? 'bg-accent/20 text-accent' : 'text-text-primary hover:bg-bg-tertiary'
                }`}
              >
                @{user.name}
              </button>
            ))}
          </div>
        )}

        {showEmojiPicker && (
          <div className="absolute bottom-full right-3 mb-2 z-50">
            <Picker
              data={data}
              onEmojiSelect={handleEmojiSelect}
              theme={theme}
              previewPosition="none"
              skinTonePosition="none"
              maxFrequentRows={1}
            />
          </div>
        )}

        {showGifPicker && (
          <GifPicker onSelect={handleGifSelect} onClose={() => setShowGifPicker(false)} />
        )}

        <form onSubmit={handleSend} className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={message}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            maxLength={500}
            placeholder="Type a message... (@mention)"
            className="flex-1 px-3 py-2 bg-bg-input border border-border rounded-md text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
          />

          <button
            type="button"
            onClick={() => { setShowEmojiPicker(!showEmojiPicker); setShowGifPicker(false); }}
            className="px-2 py-2 bg-bg-tertiary hover:bg-bg-tertiary/80 rounded-md transition-colors"
            title="Emoji"
          >
            <Smile className="w-4 h-4 text-text-secondary" />
          </button>

          {isGiphyConfigured() && (
            <button
              type="button"
              onClick={() => { setShowGifPicker(!showGifPicker); setShowEmojiPicker(false); }}
              className="px-2 py-2 bg-bg-tertiary hover:bg-bg-tertiary/80 rounded-md transition-colors"
              title="GIF"
            >
              <ImageIcon className="w-4 h-4 text-text-secondary" />
            </button>
          )}

          <button
            type="submit"
            disabled={!message.trim()}
            className="px-3 py-2 bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed rounded-md transition-colors"
          >
            <Send className="w-4 h-4 text-white" />
          </button>
        </form>
      </div>

      {pendingLink && (
        <LinkWarningModal
          url={pendingLink}
          onConfirm={handleLinkConfirm}
          onCancel={() => setPendingLink(null)}
        />
      )}
    </div>
  );
}

function MessageContent({
  text,
  myUsername,
  onLinkClick,
}: {
  text: string;
  myUsername: string;
  onLinkClick: (e: React.MouseEvent, url: string) => void;
}) {
  if (text.startsWith(GIF_PREFIX)) {
    const gifUrl = text.substring(GIF_PREFIX.length);
    return (
      <img
        src={gifUrl}
        alt="GIF"
        className="max-w-50 rounded"
        loading="lazy"
      />
    );
  }

  const segments: { type: 'text' | 'mention' | 'link'; content: string }[] = [];
  let lastIndex = 0;

  const combined = new RegExp(`(${URL_REGEX.source})|(${MENTION_REGEX.source})`, 'g');
  let match;

  while ((match = combined.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    if (match[1]) {
      segments.push({ type: 'link', content: match[1] });
    } else if (match[2]) {
      segments.push({ type: 'mention', content: match[2] });
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  if (segments.length === 0) {
    return <>{text}</>;
  }

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === 'link') {
          let domain = '';
          try { domain = new URL(seg.content).hostname; } catch { domain = ''; }
          return (
            <span key={i}>
              <a
                href={seg.content}
                onClick={(e) => onLinkClick(e, seg.content)}
                className="text-accent underline hover:text-accent-hover cursor-pointer break-all"
              >
                {seg.content}
              </a>
              {domain && (
                <span className="block text-[10px] text-text-muted mt-0.5">{domain}</span>
              )}
            </span>
          );
        }
        if (seg.type === 'mention') {
          const mentionName = seg.content.substring(1);
          const isMe = mentionName === myUsername;
          return (
            <span
              key={i}
              className={`font-semibold ${isMe ? 'bg-accent/30 text-accent px-0.5 rounded' : 'text-accent'}`}
            >
              {seg.content}
            </span>
          );
        }
        return <span key={i}>{seg.content}</span>;
      })}
    </>
  );
}
