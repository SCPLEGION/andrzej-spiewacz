#!/usr/bin/env bash
# Fetch the latest prebuilt go-librespot binary into ./bin. No Go toolchain
# required. Override the version with: GLS_TAG=v0.3.0 bash scripts/install-go-librespot.sh
set -euo pipefail

REPO="devgianlu/go-librespot"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT/bin"
mkdir -p "$BIN_DIR"

# Asset arch suffix as published on the go-librespot releases page.
case "$(uname -m)" in
  x86_64 | amd64) ARCH="x86_64" ;;
  aarch64 | arm64) ARCH="arm64" ;;
  armv7l | armv6l) ARCH="armv6" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

TAG="${GLS_TAG:-}"
if [[ -z "$TAG" ]]; then
  TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep -oP '"tag_name":\s*"\K[^"]+')"
fi
if [[ -z "$TAG" ]]; then
  echo "Could not determine latest release tag (rate limited? set GLS_TAG)." >&2
  exit 1
fi

ASSET="go-librespot_linux_${ARCH}.tar.gz"
URL="https://github.com/$REPO/releases/download/$TAG/$ASSET"

echo "Downloading $ASSET ($TAG)…"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fL --progress-bar "$URL" -o "$TMP/gls.tar.gz"
tar -xzf "$TMP/gls.tar.gz" -C "$TMP"

if [[ ! -f "$TMP/go-librespot" ]]; then
  echo "Archive did not contain a 'go-librespot' binary." >&2
  exit 1
fi

install -m 0755 "$TMP/go-librespot" "$BIN_DIR/go-librespot"
echo "Installed go-librespot $TAG -> $BIN_DIR/go-librespot"
"$BIN_DIR/go-librespot" --version 2>/dev/null || true
