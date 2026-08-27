# LumaArcade

A thin login shell in front of your own [Sunshine](https://github.com/LizardByte/Sunshine) +
[ES-DE](https://es-de.org/) + [moonlight-web-stream](https://github.com/MrCreativ3001/moonlight-web-stream)
setup. LumaArcade itself is a small Node.js/TypeScript process that runs in
the system tray on your Windows gaming PC: it password-gates access, manages
the moonlight-web-stream process's lifecycle, and reverse-proxies the browser
to it. All of the actual game streaming - capture, encode, input, the
in-stream UI - is handled by that stack, not by LumaArcade.

## How it fits together

```
Browser -> LumaArcade (auth + reverse proxy, one port)
              |
              v
     moonlight-web-stream (its own process/port)
              |
              v
   [ Moonlight protocol, LAN or internet ]
              |
              v
         Sunshine (host PC)
              |
              v
            ES-DE
              |
              v
     Emulators & PC games
```

Open the portal, log in, and you're handed off (via LumaArcade's `/stream`
reverse proxy) straight into moonlight-web-stream's browser client, which is
streaming Sunshine's video of ES-DE.

## Host setup (do this once, outside LumaArcade)

1. **Install [Sunshine](https://github.com/LizardByte/Sunshine)** and
   **[ES-DE](https://es-de.org/)** on the gaming PC. In Sunshine's web UI ->
   Applications, add an entry for ES-DE pointing at its executable, so
   Moonlight clients can request it by name.
2. **Build/install [moonlight-web-stream](https://github.com/MrCreativ3001/moonlight-web-stream).**
   It's not published to npm - clone the repo and follow its own build
   instructions (Rust + a bundled web frontend). It runs as its own local
   web server/process, separate from LumaArcade.
3. In LumaArcade's Settings -> Streaming, point `moonlightWebStreamPath` /
   port at that build and (optionally) let LumaArcade auto-start it for you.

**Use a Windows account dedicated to this**, not your own personal daily
account. Sunshine renders whatever's on that account's desktop to anyone who
connects and streams through it - your files, browser sessions, saved
passwords included. This matters even if you never touch anything else in
this README.

## Getting started (LumaArcade itself)

```bash
npm install
npm run dev:server   # terminal 1 - Fastify auth + reverse proxy on :7777
npm run dev:client   # terminal 2 - Vite dev server, proxies /api and /stream to :7777
```

Open `http://localhost:5173`, set a password on first run, then use Settings
-> Streaming to point at your moonlight-web-stream install.

For a production-style single-process run:

```bash
npm run build
npm run start         # serves the built client from the same Fastify instance on :7777
```

## Building the Windows installer

```bash
npm run package        # requires NSIS (winget install NSIS.NSIS) and a system Node install to copy from
```

Produces `installer/output/LumaArcadeSetup.exe` - a per-user install (no
admin/UAC prompt) to `%LOCALAPPDATA%\Programs\LumaArcade`, with a Start Menu
shortcut, an uninstaller, and a finish-page "start with Windows" checkbox. It
bundles a copied `node.exe` and production-only `node_modules` (including
`better-sqlite3`'s native binary) so end users don't need Node.js installed
separately - see `installer/build.mjs` for the staging steps and
`installer/LumaArcade.nsi` for the installer script itself. Sunshine, ES-DE,
and moonlight-web-stream are **not** bundled or auto-installed - set them up
per the Host setup section above, then point LumaArcade's Settings at your
moonlight-web-stream build.

## Architecture notes

- **Auth**: unchanged from earlier versions - a single app-wide password,
  signed session cookie (`luma_session`), `requireAuth` preHandler on every
  protected route. See `server/src/web/auth.ts` / `session.ts`.
- **Reverse proxy**: `server/src/web/routes/moonlight.ts` registers
  `@fastify/http-proxy` under `/stream`, behind the same `requireAuth` guard
  as everything else, proxying both HTTP and WebSocket traffic to
  `http://127.0.0.1:<moonlightWebStreamPort>`. The proxy target is bound at
  server startup, so changing the port in Settings needs a LumaArcade
  restart to take effect.
- **Process lifecycle**: `server/src/remote/moonlightWebStream.ts` spawns
  and manages the moonlight-web-stream process using the same generic
  `ManagedProcess` wrapper (`server/src/process/managedProcess.ts`) this app
  has always used for long-lived child processes - it tolerates the binary
  not being installed/configured yet rather than crashing, and now retries
  with capped exponential backoff (5s up to 2min) if the process crashes or
  exits unexpectedly instead of just staying down. Its actual launch
  arguments are `--bind-address 127.0.0.1:<port> --path-prefix /stream` -
  moonlight-web-stream has no `--port` flag; check its own `--help` output
  before changing these if you're modifying this file.
- **Auto-start** writes a `HKCU\...\Run` registry value, not a Windows
  Service - services run in Session 0, which matters less now that
  LumaArcade itself doesn't touch the display/input, but keeps LumaArcade's
  own boot behavior consistent with before.
- **Remote/WAN access**: LumaArcade itself is LAN-only - there's no bundled
  tunnel or TURN relay anymore. If you want to play from outside your LAN,
  that's handled by however you expose Sunshine/moonlight-web-stream
  (port-forwarding, your own VPN/tunnel, etc.), not by LumaArcade.

## Troubleshooting

**Moonlight/the stream shows a black screen or immediately disconnects, and
Sunshine's own log says `Failed to start the specified application` or
`Couldn't run [...]: System: Permission denied`.** This means nobody is
actually logged into the host PC's physical console session right now -
Sunshine (running as a Windows service) can only launch apps and capture the
display of whichever session is on the console, and it can't do either if
that session is sitting at an empty lock/login screen. Log into the host
PC's console (physically, or with `mstsc /admin` if connecting over RDP -
a normal RDP connection creates a *separate* session instead of resuming the
console one, which won't fix this) and retry.

**A normal RDP connection to the host "steals" the stream / breaks
Sunshine's capture even though nobody logged out.** Same root cause as
above, from the other direction: if the console account is already logged
in and you RDP into it normally, Windows creates a second, separate session
for that RDP connection rather than reconnecting you to the console one -
leaving the console empty. Use `mstsc /v:<host> /admin` to reconnect to the
console session directly instead.

**Sunshine's Desktop Duplication capture is unreliable specifically over
non-console sessions** (a known, unresolved upstream Sunshine limitation -
[LizardByte/Sunshine#1832](https://github.com/LizardByte/Sunshine/issues/1832)).
This isn't fixable by LumaArcade or moonlight-web-stream configuration -
Windows only exposes DXGI Desktop Duplication (and Windows.Graphics.Capture)
for the console-owning session, confirmed by testing directly against
multiple real virtual display drivers, none of which were visible to a
non-console session either. If you want a second person to use the PC
locally while someone streams, give that second use case its own separate
account connected over ordinary RDP (no capture needed there), rather than
trying to make the *streamed* seat the isolated one.

**The host machine also runs other software that needs an interactive
login** (Docker Desktop is a common one - it has no true headless-service
mode, and depends on someone being logged into that same session). If you
change which account auto-logs into the console for streaming purposes,
anything else depending on interactive login on a *different* account will
stop coming back after a reboot. Windows only supports one account
auto-logging into the console at a time - plan around this before switching
which account "owns" the console.

**Sunshine's `--creds` CLI flag ignores whatever config path you pass and
always writes to its own default install-directory state file.** If you
script Sunshine credential changes for a *specific* config (e.g. a
non-default instance), use the `POST /api/password` HTTP endpoint against
that instance's own port instead - it's correctly scoped per-instance and
doesn't have this bug. Learned this the hard way: `--creds` silently
overwrote an unrelated instance's admin login once.

**`moonlight-web-stream` shows as "not reachable" in Settings.** Check the
new detail line beneath that status (added specifically for this) - it
distinguishes "the process isn't running at all" from "it's running but not
answering yet," and surfaces the last error it hit, instead of just a flat
yes/no.

## Performance expectations

Sunshine/Moonlight performance depends heavily on the host's GPU encoder
(NVENC/AMF/QuickSync) and network path, not on LumaArcade or
moonlight-web-stream - neither of them touch video encoding. As a starting
point:
- 1080p60 at a moderate bitrate (~10-15 Mbps) is comfortable for most modern
  NVENC-capable GPUs on a wired LAN connection.
- Wi-Fi and internet-routed connections add latency and packet loss that
  hurt responsiveness more than raw bitrate does - prefer wired where
  possible, especially for the host.
- The browser-based moonlight-web-stream client is inherently a step behind
  a native Moonlight client on latency and decode efficiency - expect a
  noticeably better experience from LumaArcade's website for slower-paced
  games than for twitch-reflex-dependent ones.

## Known operational quirks (PM2-based deployments)

If you run `luma-arcade` / `moonlight-web-stream` under PM2 rather than the
built-in `HKCU\...\Run` auto-start (e.g. because you're also running other
Node services on the same box), a few real PM2-on-Windows gotchas are worth
knowing before you hit them the hard way:

- **PM2's inter-process communication on Windows uses a single, fixed named
  pipe** (`\\.\pipe\rpc.sock`), not one scoped per `PM2_HOME` the way it is
  on Linux/Mac (a per-`PM2_HOME` unix socket file). Two different Windows
  accounts both running their own PM2 daemon on the same machine will
  collide on that pipe - whichever daemon already holds it "wins," and the
  other account's `pm2` commands silently end up talking to it instead of
  spawning their own daemon (`connect EPERM \\.\pipe\rpc.sock` on the losing
  side). There is no supported way around this short of not running two
  PM2 daemons on one machine at once - use plain Windows Scheduled Tasks for
  a second account's processes instead.
- **A given PM2 version's CLI argument parsing for `-- <app args>` is not
  consistent across versions** - some versions correctly pass everything
  after `--` through to the child process, others misparse it as PM2's own
  flags (`error: unknown option ...`). Use an `ecosystem.config.js` file
  with an explicit `args: [...]` array instead of CLI flags when you need to
  pass arguments to a managed process - it sidesteps this entirely.
- **`pm2 list`'s "user" column is cosmetic, not authoritative.** If a
  cross-account pipe collision (above) happens, PM2 will still *display*
  the account that issued the `pm2 start` command in that column, even
  though the process was actually spawned by - and is owned by - whichever
  account's daemon actually handled the request. Verify real process
  ownership with `Get-WmiObject Win32_Process | ForEach-Object { $_.GetOwner() }`
  if this matters, not `pm2 list`.
