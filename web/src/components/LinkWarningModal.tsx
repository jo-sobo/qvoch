import { ExternalLink, ShieldAlert, X } from 'lucide-react';

interface LinkWarningModalProps {
  url: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function LinkWarningModal({ url, onConfirm, onCancel }: LinkWarningModalProps) {
  let domain = '';
  try {
    domain = new URL(url).hostname;
  } catch {
    domain = url;
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-100" onClick={onCancel}>
      <div className="bg-bg-secondary border border-border rounded-lg p-5 max-w-sm w-full mx-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-3">
          <ShieldAlert className="w-5 h-5 text-amber-400" />
          <h3 className="text-sm font-semibold text-text-primary">External Link Warning</h3>
        </div>

        <p className="text-xs text-text-secondary mb-3">
          You are about to visit an external link. QVoCh is not responsible for external content which may be harmful or illegal.
        </p>

        <div className="bg-bg-tertiary rounded px-3 py-2 mb-4 break-all">
          <span className="text-xs text-text-muted font-mono">{domain}</span>
          <p className="text-xs text-text-primary mt-0.5 break-all">{url}</p>
        </div>

        <div className="flex gap-2">
          <button
            onClick={onConfirm}
            className="flex-1 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-md transition-colors flex items-center justify-center gap-1"
          >
            <ExternalLink className="w-3.5 h-3.5" /> Continue
          </button>
          <button
            onClick={onCancel}
            className="flex-1 py-2 bg-bg-tertiary hover:bg-bg-tertiary/80 text-text-primary text-sm rounded-md transition-colors flex items-center justify-center gap-1"
          >
            <X className="w-3.5 h-3.5" /> Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
