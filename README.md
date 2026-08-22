<div align="center">

# LumaArcade

**A thin login + streaming shell for your own Sunshine + ES-DE game-streaming rig**

Password-gated access · Reverse-proxied moonlight-web-stream · One-click emulator setup · Windows installer

![Platform](https://img.shields.io/badge/platform-Windows-0078D6)
![Stack](https://img.shields.io/badge/stack-Node.js%20%2B%20TypeScript-3178C6)
![Frontend](https://img.shields.io/badge/frontend-React%20%2B%20Vite-61DAFB)
![Status](https://img.shields.io/badge/status-private%20project-lightgrey)

</div>

---

LumaArcade itself is a small Node.js/TypeScript process that runs on your
Windows gaming PC: it password-gates access, manages the
[moonlight-web-stream](https://github.com/MrCreativ3001/moonlight-web-stream)
process's lifecycle, and reverse-proxies the browser to it. All of the actual
game streaming — capture, encode, input, the in-stream UI — is handled by
[Sunshine](https://github.com/LizardByte/Sunshine) and [ES-DE](https://es-de.org/),
not by LumaArcade.

## How it fits together

```
Browser  ─▶  LumaArcade (auth + reverse proxy, one port)
                   │
                   ▼
        moonlight-web-stream (loopback only, behind the proxy)
                   │
        [ Moonlight protocol, LAN or internet ]
                   │
                   ▼
              Sunshine (host PC)
                   │
                   ▼
                 ES-DE
                   │
                   ▼
          Emulators & PC games
```

Open the portal, log in, and you're handed off (via LumaArcade's `/stream`
reverse proxy) straight into moonlight-web-stream's browser client, which is
streaming Sunshine's video of ES-DE.

## Features

| | |
|---|---|
| ✅ | Password-gated portal — one app-wide password, signed session cookie |
| ✅ | Reverse-proxied streaming client, no ports besides LumaArcade's own exposed |
| ✅ | "Detect & wire up dependencies" — finds Sunshine/ES-DE/moonlight-web-stream and wires them together |
| ✅ | Windows installer that downloads and installs Sunshine, ES-DE, and moonlight-web-stream for you |
| ✅ | Opt-in installer support for 15 emulated systems, auto-wired into ES-DE with correct default emulators |
| ✅ | Auto-fixes emulator write permissions and default control bindings on install |
| ✅ | System tray app with auto-start on login |

## Installing

Run `installer/output/LumaArcadeSetup.exe` (see [Building the Windows
installer](#building-the-windows-installer) below to produce it). During
install it downloads and sets up all three dependencies for you:

- **Sunshine** — latest Windows MSI from its GitHub releases, installed
  silently (prompts once for the UAC elevation it needs).
- **ES-DE** — latest Windows installer from its GitLab releases.
- **moonlight-web-stream** — no installer needed; the latest release zip is
  extracted to `<install dir>\moonlight-web-stream\`.

See `installer/scripts/install-deps.ps1` for exactly what it does — every
step is best-effort: a failed download or an installer that doesn't behave
as expected logs to the install log and leaves that one piece for you to
finish manually rather than aborting the whole LumaArcade install.

### After installing

1. Open LumaArcade, set your password, go to **Settings → Streaming**, and
   click **"Detect & wire up dependencies."** This finds the three installs
   above, adds ES-DE to Sunshine's app list, and points LumaArcade at
   moonlight-web-stream — everything that's purely mechanical.
2. Two things genuinely need a human once each, and can't be scripted:
   - Open **Sunshine** (`https://localhost:47990`) and create its admin
     account on the first-run welcome page.
   - Open **`/stream/`** directly (moonlight-web-stream's own UI), log in
     with the admin account you just created there on its own first visit,
     add a host (`localhost`, default port), click it, and enter the PIN it
     shows into Sunshine's pairing page.
3. (Optional, recommended) In Sunshine's `config\sunshine.conf`, set
   `dd_configuration_option = ensure_active`, `dd_resolution_option =
   manual`, and `dd_manual_resolution = 1920x1080` (or whatever you want) —
   without this Sunshine just captures whatever resolution the display
   happens to already be at, which on a headless/virtual-display box is
   often far smaller than 1080p.
4. Set up ES-DE's own systems/ROMs/emulators through its own UI — that's
   entirely outside LumaArcade, same as it would be if you'd installed ES-DE
   yourself with no LumaArcade involved at all.

## Getting started (LumaArcade itself, from source)

```bash
npm install
npm run dev:server   # terminal 1 — Fastify auth + reverse proxy on :7777
npm run dev:client   # terminal 2 — Vite dev server, proxies /api and /stream to :7777
```

Open `http://localhost:5173`, set a password on first run, then use Settings
→ Streaming as described above.

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
admin/UAC prompt for LumaArcade itself, though installing Sunshine/ES-DE
does prompt once each) to `%LOCALAPPDATA%\Programs\LumaArcade`, with a Start
Menu shortcut, an uninstaller, and a finish-page "start with Windows"
checkbox. It bundles a copied `node.exe` and production-only `node_modules`
(including `better-sqlite3`'s native binary) so end users don't need Node.js
installed separately — see `installer/build.mjs` for the staging steps and
`installer/LumaArcade.nsi` for the installer script itself.

## Architecture notes

- **Auth**: a single app-wide password, signed session cookie
  (`luma_session`), `requireAuth` preHandler on every protected route. See
  `server/src/web/auth.ts` / `session.ts`.
- **Reverse proxy**: `server/src/web/routes/moonlight.ts` registers
  `@fastify/http-proxy` under `/stream`, behind the same `requireAuth` guard
  as everything else, proxying both HTTP and WebSocket traffic to
  `http://127.0.0.1:<moonlightWebStreamPort>`. The proxy target is bound at
  server startup, so changing the port in Settings needs a LumaArcade
  restart to take effect.
- **Why `--bind-address 127.0.0.1` and `--path-prefix /stream`**: moonlight-
  web-stream's own defaults are to bind `0.0.0.0` and serve at the root of
  its origin. Left alone, that means (a) it's reachable directly, bypassing
  LumaArcade's auth gate entirely — confirmed live during development, not
  hypothetical — and (b) its frontend generates absolute-path links (e.g.
  `/api/authenticate`) that 404 once actually proxied under `/stream`
  without the prefix. `server/src/remote/moonlightWebStream.ts` passes both
  flags whenever LumaArcade spawns it itself; the installer's
  `install-deps.ps1` doesn't need to (LumaArcade always passes them at spawn
  time, regardless of how the binary got onto disk).
- **Process lifecycle**: `server/src/remote/moonlightWebStream.ts` spawns
  and manages the moonlight-web-stream process using the same generic
  `ManagedProcess` wrapper (`server/src/process/managedProcess.ts`) this app
  has always used for long-lived child processes — it tolerates the binary
  not being installed/configured yet rather than crashing.
- **Setup helper**: `server/src/setup/{detect,apply}.ts` (behind
  `POST /api/setup/run`, surfaced as the Settings page button) probes
  standard install locations for all three dependencies and does the
  mechanical wiring (ES-DE → Sunshine's `apps.json`, moonlight-web-stream
  path → LumaArcade's own settings). Deliberately does not touch
  `sunshine.conf`'s display settings or attempt any account creation/pairing
  — those need a human in a browser once each.
- **Auto-start** writes a `HKCU\...\Run` registry value, not a Windows
  Service — services run in Session 0, which matters less now that
  LumaArcade itself doesn't touch the display/input, but keeps LumaArcade's
  own boot behavior consistent with before.
- **Remote/WAN access**: LumaArcade itself is LAN-only — there's no bundled
  tunnel or TURN relay. If you want to play from outside your LAN, that's
  handled by however you expose LumaArcade's own port (port-forwarding, your
  own VPN/tunnel, a reverse proxy like Caddy/nginx in front of it, etc.), not
  by LumaArcade itself.
