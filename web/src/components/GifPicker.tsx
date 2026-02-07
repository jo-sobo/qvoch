import { useState, useEffect, useRef } from 'react';
import { searchGifs, getTrendingGifs, type GifResult } from '../services/giphy';
import { Search, X } from 'lucide-react';

interface GifPickerProps {
  onSelect: (gifUrl: string) => void;
  onClose: () => void;
}

export function GifPicker({ onSelect, onClose }: GifPickerProps) {
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState<GifResult[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    setLoading(true);
    getTrendingGifs(12)
      .then(setGifs)
      .finally(() => setLoading(false));
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      getTrendingGifs(12).then(setGifs);
      return;
    }
    debounceRef.current = setTimeout(() => {
      setLoading(true);
      searchGifs(query, 12)
        .then(setGifs)
        .finally(() => setLoading(false));
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  return (
    <div className="absolute bottom-full right-0 mb-2 w-80 bg-bg-secondary border border-border rounded-lg shadow-xl z-50 overflow-hidden">
      <div className="flex items-center gap-2 p-2 border-b border-border">
        <Search className="w-4 h-4 text-text-muted" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search GIFs..."
          className="flex-1 bg-transparent text-sm text-text-primary placeholder-text-muted focus:outline-none"
        />
        <button onClick={onClose} className="text-text-muted hover:text-text-primary">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-3 gap-1 p-2 max-h-60 overflow-y-auto">
        {loading && gifs.length === 0 && (
          <div className="col-span-3 text-center text-text-muted text-xs py-4">Loading...</div>
        )}
        {gifs.map((gif) => (
          <button
            key={gif.id}
            onClick={() => onSelect(gif.url)}
            className="aspect-square overflow-hidden rounded hover:ring-2 hover:ring-accent transition-all"
          >
            <img
              src={gif.previewUrl}
              alt={gif.title}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          </button>
        ))}
        {!loading && gifs.length === 0 && (
          <div className="col-span-3 text-center text-text-muted text-xs py-4">No GIFs found</div>
        )}
      </div>

      <div className="px-2 py-1 border-t border-border">
        <span className="text-[10px] text-text-muted">Powered by GIPHY</span>
      </div>
    </div>
  );
}
