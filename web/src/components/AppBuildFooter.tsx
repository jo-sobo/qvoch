import { getRuntimeBuildId } from '../services/runtimeConfig';

const REPO_URL = 'https://github.com/jo-sobo/qvoch';

interface AppBuildFooterProps {
  compact?: boolean;
  className?: string;
}

export function AppBuildFooter({ compact = false, className = '' }: AppBuildFooterProps) {
  const buildId = getRuntimeBuildId();
  const iconSize = compact ? 'w-3.5 h-3.5' : 'w-4 h-4';
  const textSize = compact ? 'text-[11px]' : 'text-xs';

  return (
    <div className={`flex items-center justify-center ${className}`.trim()}>
      <a
        href={REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={`inline-flex items-center gap-1.5 text-text-muted hover:text-text-secondary transition-colors ${textSize}`.trim()}
      >
        <GitHubLogo className={iconSize} />
        <span className="font-mono">build {buildId}</span>
      </a>
    </div>
  );
}

function GitHubLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 .297a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.41-4.04-1.41-.55-1.4-1.34-1.77-1.34-1.77-1.1-.75.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.08 1.85 2.83 1.32 3.52 1 .1-.78.42-1.32.76-1.63-2.66-.31-5.47-1.33-5.47-5.92 0-1.31.47-2.39 1.24-3.24-.12-.31-.54-1.56.12-3.25 0 0 1-.32 3.3 1.24a11.5 11.5 0 0 1 6 0c2.29-1.56 3.29-1.24 3.29-1.24.66 1.69.24 2.94.12 3.25.78.85 1.24 1.93 1.24 3.24 0 4.6-2.81 5.61-5.49 5.91.43.37.82 1.1.82 2.21v3.27c0 .32.22.7.82.58A12 12 0 0 0 12 .297Z" />
    </svg>
  );
}
