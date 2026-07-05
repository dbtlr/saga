#!/bin/sh
# saga installer.
#
# Downloads the standalone binary for your platform from the latest GitHub
# release and installs it to ~/.local/bin. Override the directory with
# SAGA_INSTALL_DIR; pin a version with SAGA_VERSION=v0.1.0; install the
# latest prerelease (the `--next` channel) with SAGA_NEXT=1.
#
#   curl -fsSL https://raw.githubusercontent.com/dbtlr/saga/main/install.sh | sh
#
# The installed binary lives at one stable path (~/.local/bin/saga) that hooks,
# .mcp.json, and launchd ProgramArguments all reference; updates swap that one
# file (ADR-0044). This script installs the binary only — convergence
# (`saga harness install`, `saga service install`) stays with those commands,
# and `saga doctor` is the convergence guide.
set -eu

REPO="dbtlr/saga"
INSTALL_DIR="${SAGA_INSTALL_DIR:-$HOME/.local/bin}"

err() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}
info() { printf '%s\n' "$1" >&2; }

command -v curl >/dev/null 2>&1 || err "curl is required"

# Detect platform → asset name (must match the release workflow's outputs).
os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) err "unsupported OS: $os (install from source)" ;;
esac
case "$arch" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) err "unsupported architecture: $arch" ;;
esac

# Intel macs have no published binary yet — install from source instead.
if [ "$os" = darwin ] && [ "$arch" = x64 ]; then
  err "no prebuilt binary for Intel macOS yet — install from source"
fi
asset="saga-${os}-${arch}"

if [ -n "${SAGA_VERSION:-}" ]; then
  base="https://github.com/$REPO/releases/download/$SAGA_VERSION"
elif [ -n "${SAGA_NEXT:-}" ]; then
  # Latest release including prereleases (the --next channel). GitHub's
  # /releases/latest excludes prereleases, so read the atom feed — newest
  # first, no auth. The first releases/tag/<tag> is the newest entry.
  tag=$(curl -fsSL --proto '=https' --tlsv1.2 "https://github.com/$REPO/releases.atom" \
        | grep -o 'releases/tag/[^"<]*' | head -1 | sed 's#releases/tag/##')
  [ -n "${tag:-}" ] || err "could not resolve a prerelease tag"
  info "latest prerelease: $tag"
  base="https://github.com/$REPO/releases/download/$tag"
else
  base="https://github.com/$REPO/releases/latest/download"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

info "downloading $asset ..."
curl -fSL --proto '=https' --tlsv1.2 "$base/$asset" -o "$tmp/saga" \
  || err "download failed: $base/$asset"

# Verify against SHA256SUMS. The release always publishes it, so a missing or
# mismatched checksum is a hard failure — never install an unverified binary.
curl -fsSL --proto '=https' --tlsv1.2 "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" \
  || err "could not fetch SHA256SUMS for $asset"
expected=$(grep " ${asset}$" "$tmp/SHA256SUMS" 2>/dev/null | awk '{print $1}')
[ -n "${expected:-}" ] || err "no checksum for $asset in SHA256SUMS"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/saga" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp/saga" | awk '{print $1}')
else
  err "need sha256sum or shasum to verify the download"
fi
[ "$actual" = "$expected" ] || err "checksum mismatch for $asset"
info "checksum ok"

chmod +x "$tmp/saga"
mkdir -p "$INSTALL_DIR"
mv "$tmp/saga" "$INSTALL_DIR/saga"
info "installed saga to $INSTALL_DIR/saga"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    info "note: $INSTALL_DIR is not on your PATH — add it:"
    info "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

info "done — run: saga --help"
