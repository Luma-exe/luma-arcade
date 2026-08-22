<div align="center">

# LumaArcade

**A thin login + streaming shell for your own Sunshine + ES-DE game-streaming rig**

Password-gated access · Reverse-proxied moonlight-web-stream · 26 emulators installed and configured for you · Windows installer

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
| ✅ | 26 emulators, opt-in per system — downloaded, correctly set as each system's default in ES-DE, and set to launch fullscreen, all with zero manual config |
| ✅ | RetroArch's own cores fetched automatically too — RetroArch alone is normally an empty shell |
| ✅ | Auto-fixes emulator write permissions, default control bindings, and known ES-DE/emulator wiring bugs on install |
| ✅ | Your installed Steam / Epic Games Store library synced straight into ES-DE, no manual shortcuts |
| ✅ | A dedicated "Emulators" system in ES-DE for opening any emulator's own settings directly, no ROM needed |
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
4. Drop your ROMs/games into ES-DE's `ROMS\<system>` folders as usual — that
   part's still on you, same as any ES-DE install. Everything about the
   emulators themselves (see below) is already done.

## Emulators

This is the part that used to be the tedious bit: download the right
emulator for each system, put it exactly where ES-DE expects it, fix ES-DE's
default command (which is very often a RetroArch core with no core actually
installed, not the standalone emulator you meant), configure controls, and
grant it permission to save its own settings. The installer's two emulator
pages do all of that for whichever systems you check — for 26 systems
covering essentially every console/handheld/arcade board worth emulating —
so once your ROMs are in place, you're playing, not configuring.

Specifically, for every emulator you select:

- **Downloaded** from its actual official release (GitHub, or the project's
  own CDN where it doesn't publish to GitHub) and staged exactly where ES-DE
  already looks for it — no `es_find_rules.xml` editing needed for most of
  them, since ES-DE's own bundled rules already expect this layout.
- **Set as that system's default emulator** in ES-DE — fixing the very
  common case where a system's first-listed command is a RetroArch core with
  no core downloaded, which otherwise just fails silently with no error.
- **Set to launch fullscreen** by default, since a windowed emulator over a
  game stream is just a small floating window on a black background.
- **Given write access** to its own install folder — Windows blocks
  non-elevated processes (which is how Sunshine launches everything) from
  writing under `Program Files` by default, so without this, emulators like
  melonDS fail outright the first time they try to save a setting.
- **Given working default controls** where the emulator ships with none at
  all — melonDS in particular has every button unbound out of the box, so
  this writes sane keyboard + gamepad (XInput) bindings for it.
- **RetroArch's own cores** are fetched too, for the systems this project
  covers (NES, SNES, N64, Genesis, MAME, Saturn, Neo Geo, and more) — a bare
  RetroArch install has zero cores and normally expects you to use its
  Online Updater by hand.

A few systems (Sega CD, Saturn, TurboGrafx-CD, Neo Geo, Xbox, Switch, PS3,
PS Vita, Wii U, 3DS) additionally need a BIOS/firmware file that no installer
can legally provide — see [BIOS and firmware files](#bios-and-firmware-files)
below for exactly what's needed and where it goes.

Once emulators are installed, ES-DE also gets a dedicated **Emulators**
system (ES-DE's own built-in one, not something this project invented) with
one entry per installed emulator that opens that emulator's own window
directly — no ROM, no game — for the rare case you need to get into an
emulator's own settings (BIOS paths, controller remapping, graphics backend)
that ES-DE itself doesn't expose.

### BIOS and firmware files

The emulator-selection step of the installer shows this too, but worth
repeating here: a handful of systems are legally unable to work at all
without a BIOS/firmware dump — copyrighted files from Nintendo/Sony/
Microsoft that no emulator project (this one included) can legally bundle.
You provide these yourself, dumped from hardware you own.

**Won't launch at all without one:**

| System | Emulator | What it needs |
|---|---|---|
| Xbox | xemu | MCPX boot ROM + an Xbox hard drive image |
| Switch | Eden | Switch firmware + `prod.keys` |
| PS3 | RPCS3 | PS3 firmware — installed once from inside RPCS3 itself |
| PS Vita | Vita3K | PS Vita firmware — installed once from inside Vita3K itself |
| Wii U | Cemu | a `keys.txt` file, needed by most retail games |
| 3DS | Azahar | 3DS firmware + `seeddb.bin`, needed by many games |
| Sega CD | RetroArch — Genesis Plus GX | `bios_CD_U.bin` (US) / `bios_CD_E.bin` (EU) / `bios_CD_J.bin` (JP) in RetroArch's `system\` folder |
| Saturn | RetroArch — Beetle Saturn | `sega_101.bin` (US) / `mpr-18811-mx.ic1` (EU) / `mpr-17933.bin` (JP) in RetroArch's `system\` folder |
| TurboGrafx-CD | RetroArch — Beetle PCE | `syscard3.pce` in RetroArch's `system\` folder |
| Neo Geo | RetroArch — FBNeo | `neogeo.zip`, specifically in `system\neogeo\neogeo.zip` — **not** next to the game ROMs, that's the mistake that makes it look like nothing's wrong when it's really just in the wrong folder |
| Other arcade/MAME romsets | RetroArch — MAME | some romsets need their own separate BIOS zip alongside the game files too |

Confirmed live: Sega CD, Saturn, and TurboGrafx-CD games did nothing at all
when clicked — no error — until the right BIOS file was in place; these
three don't have a fallback mode the way some other systems below do.

**Work without one, but compatibility is noticeably better with a real
BIOS:** PS1 (DuckStation), PS2 (PCSX2), PSP (PPSSPP), Dreamcast (Flycast),
and DS (melonDS, for DSi-specific features).

Where each BIOS file actually goes is emulator-specific — check that
emulator's own settings/documentation (usually a "BIOS" or "Firmware" entry
in its own settings menu) rather than guessing at a folder. For the
RetroArch-core systems above, `install-emulators.ps1` already creates
`RetroArch-Win64\system\neogeo\` for you and will auto-copy a `neogeo.zip`
it finds sitting in your `neogeo` ROM folder into the right place — the
BIOS file itself still has to come from you, this just fixes the folder.

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
