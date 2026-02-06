const API_KEY = import.meta.env.VITE_GIPHY_API_KEY || '';
const BASE_URL = 'https://api.giphy.com/v1/gifs';

export interface GifResult {
  id: string;
  title: string;
  url: string; // full-size GIF
  previewUrl: string; // smaller preview
  width: number;
  height: number;
}

function mapGif(item: Record<string, unknown>): GifResult {
  const images = item.images as Record<string, Record<string, string>>;
  const fixed = images.fixed_width;
  const original = images.original;
  return {
    id: item.id as string,
    title: item.title as string,
    url: original?.url || fixed?.url || '',
    previewUrl: fixed?.url || '',
    width: Number(fixed?.width || 200),
    height: Number(fixed?.height || 200),
  };
}

export async function searchGifs(query: string, limit = 20): Promise<GifResult[]> {
  if (!API_KEY) return [];
  const url = `${BASE_URL}/search?api_key=${API_KEY}&q=${encodeURIComponent(query)}&limit=${limit}&rating=pg-13`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  return (json.data as Record<string, unknown>[]).map(mapGif);
}

export async function getTrendingGifs(limit = 20): Promise<GifResult[]> {
  if (!API_KEY) return [];
  const url = `${BASE_URL}/trending?api_key=${API_KEY}&limit=${limit}&rating=pg-13`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  return (json.data as Record<string, unknown>[]).map(mapGif);
}

export function isGiphyConfigured(): boolean {
  return !!API_KEY;
}
