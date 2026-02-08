import { useStore } from '../stores/useStore';
import { send } from '../services/socket';
import { useState, useEffect } from 'react';
import { UserPlus, X } from 'lucide-react';

export function InviteModal() {
  const pendingInvite = useStore((s) => s.pendingInvite);
  const setPendingInvite = useStore((s) => s.setPendingInvite);

  if (!pendingInvite) return null;

  const handleAccept = () => {
    send('sub-response', {
      inviteId: pendingInvite.inviteId,
      accepted: true,
    });
    setPendingInvite(null);
  };

  const handleDecline = () => {
    send('sub-response', {
      inviteId: pendingInvite.inviteId,
      accepted: false,
    });
    setPendingInvite(null);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-bg-secondary border border-border rounded-lg p-6 max-w-sm w-full mx-4 shadow-xl">
        <div className="flex items-center gap-3 mb-4">
          <UserPlus className="w-6 h-6 text-accent" />
          <h3 className="text-lg font-semibold text-text-primary">
            Private Channel Invite
          </h3>
        </div>

        <p className="text-text-secondary text-sm mb-4">
          <span className="text-text-primary font-medium">
            {pendingInvite.fromName}
          </span>{' '}
          invited you to{' '}
          <span className="text-text-primary font-medium">
            {pendingInvite.channelName || 'a private channel'}
          </span>
          .
        </p>

        <InviteCountdown key={pendingInvite.inviteId} />

        <div className="flex gap-3">
          <button
            onClick={handleAccept}
            className="flex-1 py-2 bg-accent hover:bg-accent-hover text-white font-medium rounded-md transition-colors text-sm"
          >
            Accept
          </button>
          <button
            onClick={handleDecline}
            className="flex-1 py-2 bg-bg-tertiary hover:bg-bg-tertiary/80 text-text-primary rounded-md transition-colors text-sm flex items-center justify-center gap-1"
          >
            <X className="w-4 h-4" />
            Decline
          </button>
        </div>
      </div>
    </div>
  );
}

function InviteCountdown() {
  const [countdown, setCountdown] = useState(30);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          window.clearInterval(timer);
          return 0;
        }
        return c - 1;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="text-xs text-text-muted mb-4">
      Expires in {countdown}s
    </div>
  );
}
