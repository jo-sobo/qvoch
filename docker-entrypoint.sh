#!/bin/sh
set -eu

RUNTIME_CONFIG_PATH="/app/web/dist/runtime-config.js"
GIPHY_KEY="${GIPHY_API_KEY:-}"

# Escape for single-quoted JavaScript string literal.
ESCAPED_GIPHY_KEY=$(printf '%s' "$GIPHY_KEY" | sed "s/\\\\/\\\\\\\\/g; s/'/'\"'\"'/g")

cat > "$RUNTIME_CONFIG_PATH" <<EOF
window.__QVOCH_CONFIG__ = Object.assign({}, window.__QVOCH_CONFIG__, {
  giphyApiKey: '${ESCAPED_GIPHY_KEY}',
});
EOF

exec /app/server
