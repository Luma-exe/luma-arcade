# LumaArcade

Self-hosted game streaming portal — a single Node.js/TypeScript process on your
Windows gaming PC that runs in the system tray, serves a web UI, and streams
your desktop/games to any browser with low-latency WebRTC video and
mouse/keyboard/gamepad input piped back.

All six build phases from the project brief are implemented: tray app +
embedded server + auth, Steam/Epic/emulation library scanning with IGDB box
art, per-game window capture with full-desktop fallback, optional Cloudflare
Tunnel + coturn remote access, and the polish pass (reconnect/resume,
connection-quality HUD, gamepad passthrough).

## Prerequisites (verify before running)

1. **Node.js 20+** and npm.
2. **GStreamer 1.22+** on `PATH`, including:
   - `gst-plugins-bad` (for `d3d11screencapturesrc`)
   - `gst-plugins-rs`'s `webrtcsink` element — **not always bundled in the
     stock Windows MSVC installer.** Verify:
     ```bash
     gst-inspect-1.0 webrtcsink
     gst-inspect-1.0 d3d11screencapturesrc
     ```
     If `webrtcsink` is missing, you'll need a GStreamer build that includes
     `gst-plugins-rs`. Per-game window capture additionally needs the
     `window-handle` property on `d3d11screencapturesrc` (recent GStreamer) —
     if it's absent, the app automatically falls back to full-desktop capture.
3. An NVIDIA GPU + driver with NVENC. `webrtcsink` auto-negotiates its
   encoder and should prefer a hardware H.264 encoder when available;
   confirm with `gst-inspect-1.0 nvh264enc`.
4. **Optional — gamepad passthrough**: [ViGEmBus](https://github.com/ViGEm/ViGEmBus)
   installed system-wide. Without it, gamepad input from the browser is
   silently ignored (logged once) rather than crashing anything.
5. **Optional — remote access**: `cloudflared.exe` on `PATH`, and a coturn
   Windows build (`turnserver.exe`) if you want a bundled TURN relay — coturn
   isn't npm-installable, so download the official Windows release yourself
   and point Settings → Network at its path.
6. **Optional — box art**: a free Twitch developer app (for the IGDB API) at
   dev.twitch.tv/console/apps, entered in Settings → Box art.

## Getting started

```bash
npm install
npm run dev:server   # terminal 1 — Fastify + GStreamer orchestration on :7777
npm run dev:client   # terminal 2 — Vite dev server, proxies /api and /signalling to :7777
```

Open `http://localhost:5173`, set a password on first run, then use Settings
to enable the sources you want (Steam/Epic are auto-detected; Emulation and
Custom Apps need folders/paths configured first) and hit **Rescan library**.

For a production-style single-process run:

```bash
npm run build
npm run start         # serves the built client from the same Fastify instance on :7777
```

## Building the Windows installer

```bash
npm run package        # requires NSIS (winget install NSIS.NSIS) and a system Node install to copy from
```

Produces `installer/output/LumaArcadeSetup.exe` — a per-user install (no
admin/UAC prompt) to `%LOCALAPPDATA%\Programs\LumaArcade`, with a Start Menu
shortcut, an uninstaller, and a finish-page "start with Windows" checkbox.
It bundles a copied `node.exe` and production-only `node_modules` (including
`better-sqlite3`'s native binary) so end users don't need Node.js installed
separately — see `installer/build.mjs` for the staging steps and
`installer/LumaArcade.nsi` for the installer script itself. GStreamer/
ViGEmBus/cloudflared/coturn are **not** bundled (see Prerequisites above);
the installer just warns if `gst-launch-1.0` isn't found on `PATH`.

## What each source needs to work

- **Steam / Epic**: auto-detected from the local install (registry lookup /
  `libraryfolders.vdf` for Steam, `EpicGamesLauncher\Data\Manifests` for
  Epic). Launching shells out to the `steam://` / `com.epicgames.launcher://`
  protocol handlers, so the respective client must be installed.
- **Emulation**: add a ROM folder per console in Settings, pointing at a
  standalone emulator executable and a launch-args template (`{rom}`
  placeholder substituted with the ROM path at launch time) — this supports
  any emulator's CLI convention without hardcoding one per console.
- **Custom apps**: whitelist any `.exe` in Settings; shows up as its own tile.

## Architecture notes

- **WebRTC signalling**: GStreamer's `webrtcsink` element owns its own
  `RTCPeerConnection` inside the spawned `gst-launch-1.0` child process and
  speaks the `gst-plugins-rs` signalling protocol (JSON over WebSocket) to
  negotiate SDP/ICE. The Node server implements that protocol as a relay in
  `server/src/signalling/server.ts` — both the GStreamer process and the
  browser connect to it as peers. This was reconstructed from the
  `net/webrtc/protocol` crate in `gst-plugins-rs`; if the stream fails to
  negotiate, diff the message shapes against that crate's current source.
- **Input**: because the media `RTCPeerConnection` lives inside the
  GStreamer child process rather than in Node, input events (mouse/keyboard/
  gamepad) are sent over a dedicated authenticated WebSocket (`/input`)
  rather than a WebRTC data channel — there's no in-process endpoint in Node
  for a data channel terminating on the GStreamer side to reach.
- **Per-game capture**: after launching a game we spawned ourselves
  (emulation/custom), the server polls for the process's main window handle
  and switches `d3d11screencapturesrc` to `window-handle=<hwnd>`. Steam/Epic
  are launched via OS protocol handlers, so we never get a process id for
  them — those always stream full desktop (documented limitation, not a bug).
- **Auto-start** writes a `HKCU\...\Run` registry value, not a Windows
  Service — services run in Session 0 and can't do screen capture or
  `SendInput`.
- **Remote access**: Cloudflare Tunnel proxies the HTTPS/WSS signalling
  traffic but not raw UDP WebRTC/TURN media — if you enable the bundled
  coturn relay, its port must be reachable directly (router port-forward),
  configured via a separate "public host" setting rather than reused from
  the tunnel hostname. Cloudflare Access policy (email OTP, domain) is set up
  in the Cloudflare dashboard, not in this app; the app-level password stays
  on regardless, as a second layer and because LAN access bypasses the
  tunnel entirely.
- **Gamepad**: verified against the actual `vigemclient` package source
  (`node_modules/vigemclient/lib/X360Controller.js`) rather than assumed —
  sticks take -1..1, triggers 0..1, matching the browser Gamepad API closely.
  Degrades to a no-op with a single logged warning if ViGEmBus isn't
  installed.

## Anti-cheat caveat

Games with kernel-level anti-cheat (Valorant, some CoD/Battlefield titles)
may flag capture or input-injection tooling. This is expected — don't try to
work around it by hiding the program.
