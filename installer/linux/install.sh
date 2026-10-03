#!/usr/bin/env bash
# Luma Arcade for Linux - EARLY TESTING.
#
# Installs Luma Arcade for the signed-in user (no root needed): the server,
# moonlight-web-stream and a portable Node, under ~/.local/opt/luma-arcade,
# started by a systemd user service. Sunshine has to be installed and set up
# already (https://github.com/LizardByte/Sunshine).
#
#   curl -fsSL https://github.com/Luma-exe/luma-arcade/releases/latest/download/install.sh | bash
#
# Options:
#   --bundle FILE   install from a local LumaArcade-linux.tar.gz
#   --yes           don't ask before installing (early-testing notice)
#   --no-admin      skip creating the admin account (the first sign-in creates it)
#   --no-service    don't set up the systemd user service
#   --allow-root    install as root anyway (containers, testing)
# Running it again upgrades in place and keeps accounts, settings and history.
set -euo pipefail

REPO="Luma-exe/luma-arcade"
APP_DIR="${LUMA_APP_DIR:-$HOME/.local/opt/luma-arcade}"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/luma-arcade"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
PORT=7777

# Pinned downloads, checked against their SHA-256 (the same versions the
# Windows installer ships).
NODE_VERSION="24.21.0"
NODE_SHA_x64="fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6"
NODE_SHA_arm64="6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2"
MOONLIGHT_VERSION="v2.10.0"
MOONLIGHT_SHA_x86_64="b17fa535676a1c118bc1eb009134644cab98190b36a0776fb1b4a505d569f5eb"
MOONLIGHT_SHA_aarch64="1a6bb6845756883671a5a783c0797367e84166c8210f8cfa51059f434f0e5a3a"

BUNDLE="" YES=0 ADMIN=1 SERVICE=1 ALLOW_ROOT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --bundle) BUNDLE="$2"; shift ;;
    --yes|-y) YES=1 ;;
    --no-admin) ADMIN=0 ;;
    --no-service) SERVICE=0 ;;
    --allow-root) ALLOW_ROOT=1 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------ checks
[ "$(uname -s)" = "Linux" ] || die "This installer is for Linux. On Windows, use LumaArcadeSetup.exe."
[ "$(id -u)" -ne 0 ] || [ "$ALLOW_ROOT" -eq 1 ] || die "Run it as the user who plays and runs Sunshine, not as root (no sudo)."
case "$(uname -m)" in
  x86_64)  NODE_ARCH=x64;   NODE_SHA=$NODE_SHA_x64;   ML_ARCH=x86_64;  ML_SHA=$MOONLIGHT_SHA_x86_64 ;;
  aarch64) NODE_ARCH=arm64; NODE_SHA=$NODE_SHA_arm64; ML_ARCH=aarch64; ML_SHA=$MOONLIGHT_SHA_aarch64 ;;
  *) die "Unsupported processor: $(uname -m) (x86_64 and aarch64 only)" ;;
esac
for tool in curl tar xz sha256sum; do
  command -v "$tool" >/dev/null || die "'$tool' is needed - install it with your package manager first."
done

cat <<'EOF'

  Luma Arcade for Linux is in VERY EARLY TESTING.

  Tested so far: installing, upgrading, signing in and Host health on
  Ubuntu 24.04. Streaming, accounts, turns, co-op, guest links, time limits
  and play history use the same code as on Windows and should work, but
  streaming from a real Linux gaming PC isn't confirmed yet.

  Not yet on Linux: the Home button and window switching, lockdown,
  per-player saves, ES-DE game tracking and the Steam/Epic import.

  Expect rough edges, and please report what you find:
  https://github.com/Luma-exe/luma-arcade/issues

EOF
if [ "$YES" -ne 1 ]; then
  if [ -r /dev/tty ]; then
    printf 'Install anyway? [y/N] '
    read -r answer </dev/tty
    case "$answer" in y|Y|yes|YES) ;; *) echo "Nothing installed."; exit 0 ;; esac
  else
    die "Run it again with --yes to accept the early-testing notice."
  fi
fi

if ! command -v sunshine >/dev/null && ! flatpak info dev.lizardbyte.app.Sunshine >/dev/null 2>&1; then
  warn "Sunshine wasn't found. Luma Arcade streams through it: install it from https://github.com/LizardByte/Sunshine/releases"
  warn "(continuing - you can install Sunshine afterwards and pair it in Luma Arcade)"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

download() { # url file sha256
  curl -fsSL --retry 3 -o "$2" "$1" || die "Couldn't download $1"
  if [ -n "${3:-}" ]; then
    echo "$3  $2" | sha256sum -c --status - || die "$(basename "$2") doesn't match its expected checksum - not installing it"
  fi
}

# ------------------------------------------------------------------ the bundle
if [ -z "$BUNDLE" ]; then
  say "Downloading Luma Arcade"
  BUNDLE="$WORK/LumaArcade-linux.tar.gz"
  download "https://github.com/$REPO/releases/latest/download/LumaArcade-linux.tar.gz" "$BUNDLE"
fi
[ -f "$BUNDLE" ] || die "Bundle not found: $BUNDLE"
tar -xzf "$BUNDLE" -C "$WORK"
SRC="$WORK/luma-arcade"
[ -f "$SRC/server/dist/main.js" ] || die "That isn't a Luma Arcade Linux bundle"
VERSION="$(cat "$SRC/VERSION" 2>/dev/null || echo '?')"

UPGRADE=0
[ -f "$APP_DIR/server/dist/main.js" ] && UPGRADE=1
if [ "$UPGRADE" -eq 1 ] && systemctl --user is-active --quiet luma-arcade 2>/dev/null; then
  say "Stopping the running Luma Arcade for the upgrade"
  systemctl --user stop luma-arcade
fi

say "Installing Luma Arcade $VERSION to $APP_DIR"
mkdir -p "$APP_DIR" "$DATA_DIR"
# Replaced: the program and web files. Kept: the database (server/luma-arcade.db),
# moonlight-web-stream's accounts and config (moonlight-web-stream/server/*.json).
rm -rf "$APP_DIR/server/dist" "$APP_DIR/server/assets" "$APP_DIR/moonlight-web-stream/static" "$APP_DIR/setup"
cp -a "$SRC/." "$APP_DIR/"
chmod +x "$APP_DIR/install.sh" "$APP_DIR/uninstall.sh"

# ------------------------------------------------------------------ Node
if [ "$("$APP_DIR/node/bin/node" --version 2>/dev/null)" != "v$NODE_VERSION" ]; then
  say "Downloading Node.js $NODE_VERSION"
  download "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz" "$WORK/node.tar.xz" "$NODE_SHA"
  rm -rf "$APP_DIR/node" && mkdir -p "$APP_DIR/node"
  tar -xJf "$WORK/node.tar.xz" -C "$APP_DIR/node" --strip-components=1
fi
export PATH="$APP_DIR/node/bin:$PATH"

# ------------------------------------------------------------------ moonlight-web-stream
ML="$APP_DIR/moonlight-web-stream"
if [ "$(cat "$ML/.version" 2>/dev/null)" != "$MOONLIGHT_VERSION" ] || [ ! -x "$ML/web-server" ]; then
  say "Downloading moonlight-web-stream $MOONLIGHT_VERSION"
  download "https://github.com/MrCreativ3001/moonlight-web-stream/releases/download/$MOONLIGHT_VERSION/moonlight-web-$ML_ARCH-unknown-linux-gnu.tar.gz" "$WORK/ml.tar.gz" "$ML_SHA"
  mkdir -p "$WORK/ml"
  tar -xzf "$WORK/ml.tar.gz" -C "$WORK/ml"
  # Only its programs: the web files are Luma Arcade's own (from the bundle).
  install -m 755 "$WORK/ml/package/web-server" "$WORK/ml/package/streamer" "$ML/"
  echo "$MOONLIGHT_VERSION" > "$ML/.version"
fi
[ -f "$ML/server/config.json" ] || cp "$ML/server/config.default.json" "$ML/server/config.json"

# ------------------------------------------------------------------ dependencies
say "Installing the server's libraries"
(cd "$APP_DIR/server" && npm install --omit=dev --no-audit --no-fund --loglevel=error) || die "Installing the server's libraries failed"
node -e "new (require('$APP_DIR/server/node_modules/better-sqlite3'))(':memory:').close()" \
  || die "The database library won't load on this system"

# ------------------------------------------------------------------ admin account and pairing
if [ "$ADMIN" -eq 1 ] && [ ! -s "$ML/server/data.json" ] && [ -r /dev/tty ]; then
  say "Your admin account"
  note "The name and password you'll sign in to Luma Arcade with. Setup also pairs it with Sunshine,"
  note "using the same name and password for Sunshine's web UI (https://localhost:47990)."
  note "Leave the name empty to skip: the first sign-in then creates the admin."
  printf '    Name: '; read -r ADMIN_NAME </dev/tty
  if [ -n "$ADMIN_NAME" ]; then
    while :; do
      printf '    Password (8+ characters): '; read -rs ADMIN_PASS </dev/tty; echo
      printf '    Again: '; read -rs ADMIN_PASS2 </dev/tty; echo
      [ "$ADMIN_PASS" = "$ADMIN_PASS2" ] || { warn "They don't match."; continue; }
      [ "${#ADMIN_PASS}" -ge 8 ] || { warn "Use at least 8 characters."; continue; }
      break
    done
    umask 077
    printf '%s\n%s\n' "$ADMIN_NAME" "$ADMIN_PASS" > "$WORK/admin.txt"
    unset ADMIN_PASS ADMIN_PASS2
    # Creates the account, adds this PC's Sunshine and pairs (deletes admin.txt).
    node "$APP_DIR/setup/first-run.mjs" "$APP_DIR" "$WORK/admin.txt" \
      || warn "Setting up the admin or pairing didn't finish - you can do it in Luma Arcade (sign in, add the PC \"localhost\")"
  fi
fi

# ------------------------------------------------------------------ service
if [ "$SERVICE" -eq 1 ] && systemctl --user show-environment >/dev/null 2>&1; then
  say "Starting Luma Arcade (systemd user service luma-arcade)"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/luma-arcade.service" <<EOF
[Unit]
Description=Luma Arcade (Linux early testing)
After=network-online.target

[Service]
WorkingDirectory=$APP_DIR
Environment=LUMA_DATA_DIR=$DATA_DIR
ExecStart=$APP_DIR/node/bin/node $APP_DIR/server/dist/main.js --background
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now luma-arcade >/dev/null
  STARTED=1
else
  STARTED=0
fi

echo
say "Luma Arcade $VERSION is installed (Linux early testing)"
if [ "$STARTED" -eq 1 ]; then
  note "Open http://localhost:$PORT on this PC, or http://<this PC's address>:$PORT on your network."
  note "It starts whenever you sign in. Logs: journalctl --user -u luma-arcade -f"
else
  note "Start it with: LUMA_DATA_DIR=$DATA_DIR $APP_DIR/node/bin/node $APP_DIR/server/dist/main.js"
fi
note "Check Settings > Host health first - it says what's missing."
note "Remove it with: $APP_DIR/uninstall.sh"
