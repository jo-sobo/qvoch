declare global {
  interface Window {
    __QVOCH_CONFIG__?: {
      giphyApiKey?: string;
      buildId?: string;
    };
  }
}

function getConfig(): NonNullable<Window['__QVOCH_CONFIG__']> {
  return window.__QVOCH_CONFIG__ || {};
}

export function getRuntimeGiphyApiKey(): string {
  return getConfig().giphyApiKey || '';
}

export function getRuntimeBuildId(): string {
  const runtimeBuild = (getConfig().buildId || '').trim();
  if (runtimeBuild) return runtimeBuild;
  if (import.meta.env.DEV) return 'non-official-dev-local';
  return 'non-official-unknown';
}
