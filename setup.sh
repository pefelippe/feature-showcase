#!/usr/bin/env bash
# Installs what showcase.mjs needs without sudo: ffmpeg, the Kokoro voice, Playwright and its
# Chromium. On Linux it also extracts the system libraries Chromium links against into tools/libs
# instead of installing them system-wide.
set -euo pipefail
S="$(cd "$(dirname "$0")" && pwd)"

(cd "$S/tools" && npm ci --silent && npx playwright install chromium >/dev/null)

[ "$(uname)" = Linux ] || { echo "Ready."; exit 0; }

BIN="$(find ~/.cache/ms-playwright -path "*chromium-*" -type f -name chrome | sort | tail -1)"
LIBDIR="$S/tools/libs/root/usr/lib/x86_64-linux-gnu"
MISSING="$(LD_LIBRARY_PATH="$LIBDIR" ldd "$BIN" | awk '/not found/ {print $1}')"
if [ -n "$MISSING" ] && command -v apt-get >/dev/null; then
  mkdir -p "$S/tools/libs/debs"
  cd "$S/tools/libs/debs"
  PACKAGES=""
  for lib in $MISSING; do
    pkg="$(apt-file search -l "$lib" 2>/dev/null | head -1 || true)"
    [ -z "$pkg" ] && pkg="$(dpkg -S "$lib" 2>/dev/null | head -1 | cut -d: -f1 || true)"
    PACKAGES="$PACKAGES ${pkg:-}"
  done
  # Debian/Ubuntu names for what Chromium usually lacks on a bare install (WSL, containers).
  apt-get download $PACKAGES libnspr4 libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 \
    libatspi2.0-0t64 libxdamage1 libxkbcommon0 libasound2t64 libcups2t64 libcairo2 libpango-1.0-0 \
    libavahi-common3 libavahi-client3 libavahi-common-data libpixman-1-0 libxcb-render0 libxcb-shm0 \
    libthai0 libdatrie1 libfribidi0 libharfbuzz0b libgraphite2-3 2>/dev/null || true
  for deb in *.deb; do dpkg-deb -x "$deb" "$S/tools/libs/root"; done
fi

STILL="$(LD_LIBRARY_PATH="$LIBDIR" ldd "$BIN" | awk '/not found/ {print $1}')"
if [ -n "$STILL" ]; then
  echo "Still missing: $STILL"
  echo "Run once: sudo npx --prefix $S/tools playwright install-deps chromium"
  exit 1
fi
echo "Ready."
