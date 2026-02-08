#!/usr/bin/env sh
set -eu

IMAGE_TAG="${1:-qvoch}"

BRANCH_RAW="$(git symbolic-ref --short -q HEAD 2>/dev/null || git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
if [ "$BRANCH_RAW" = "HEAD" ]; then
  BRANCH_RAW="detached"
fi
BRANCH="$(printf '%s' "$BRANCH_RAW" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g; s/--*/-/g; s/^-//; s/-$//')"
if [ -z "$BRANCH" ]; then
  BRANCH="unknown"
fi
COMMIT="$(git rev-parse --short=12 HEAD 2>/dev/null || echo nogit)"
if [ "$COMMIT" = "nogit" ]; then
  echo "ERROR: Could not read git commit metadata."
  echo "Run this script from a git clone, or build manually with --build-arg BUILD_ID=..."
  exit 1
fi
BUILD_TIME="$(date -u +%Y%m%d-%H%M%S)"
DIRTY_SUFFIX=""
if ! git diff --quiet --ignore-submodules HEAD -- 2>/dev/null; then
  DIRTY_SUFFIX="-dirty"
fi
BUILD_ID="non-official-${BRANCH}-${COMMIT}-${BUILD_TIME}${DIRTY_SUFFIX}"

echo "Building ${IMAGE_TAG}"
echo "  branch: ${BRANCH}"
echo "  commit: ${COMMIT}"
echo "  time:   ${BUILD_TIME}"
echo "  build:  ${BUILD_ID}"

docker build \
  --build-arg BUILD_ID="${BUILD_ID}" \
  --build-arg BUILD_BRANCH="${BRANCH}" \
  --build-arg BUILD_COMMIT="${COMMIT}" \
  --build-arg BUILD_TIME="${BUILD_TIME}" \
  -t "${IMAGE_TAG}" \
  .
