#!/usr/bin/env bash
# Removes Luma Arcade for Linux (early beta). Keeps its accounts, settings
# and play history, so installing again picks up where it left off, unless
# --purge is given.
set -euo pipefail

APP_DIR="${LUMA_APP_DIR:-$HOME/.local/opt/luma-arcade}"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/luma-arcade"
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/luma-arcade.service"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

if systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user disable --now luma-arcade >/dev/null 2>&1 || true
  rm -f "$UNIT"
  systemctl --user daemon-reload || true
fi

if [ "$PURGE" -eq 1 ]; then
  rm -rf "$APP_DIR" "$DATA_DIR"
  echo "Luma Arcade and all its data were removed."
  exit 0
fi

# Everything but the data: the database, and moonlight-web-stream's accounts and config.
if [ -d "$APP_DIR" ]; then
  find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name server ! -name moonlight-web-stream -exec rm -rf {} +
  [ -d "$APP_DIR/server" ] && find "$APP_DIR/server" -mindepth 1 -maxdepth 1 ! -name 'luma-arcade.db*' ! -name 'https.json' -exec rm -rf {} +
  if [ -d "$APP_DIR/moonlight-web-stream" ]; then
    find "$APP_DIR/moonlight-web-stream" -mindepth 1 -maxdepth 1 ! -name server -exec rm -rf {} +
    find "$APP_DIR/moonlight-web-stream/server" -mindepth 1 -maxdepth 1 ! -name 'data.json' ! -name 'config.json' -exec rm -rf {} + 2>/dev/null || true
  fi
fi
echo "Luma Arcade was removed. Accounts, settings and history are kept in $APP_DIR"
echo "(installing again picks them up; run with --purge to delete them too)."
