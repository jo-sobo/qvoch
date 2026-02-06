import { useEffect } from 'react';
import { useStore } from '../stores/useStore';
import { X } from 'lucide-react';

export function ToastContainer() {
  const toasts = useStore((s) => s.toasts);
  const removeToast = useStore((s) => s.removeToast);

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} id={toast.id} message={toast.message} onDismiss={removeToast} />
      ))}
    </div>
  );
}

function ToastItem({ id, message, onDismiss }: { id: string; message: string; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(id), 3000);
    return () => clearTimeout(timer);
  }, [id, onDismiss]);

  return (
    <div className="pointer-events-auto flex items-center gap-2 px-4 py-2.5 bg-bg-secondary border border-border rounded-lg shadow-lg animate-[slideDown_0.2s_ease-out]">
      <span className="text-sm text-text-primary">{message}</span>
      <button onClick={() => onDismiss(id)} className="text-text-muted hover:text-text-primary transition-colors">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
