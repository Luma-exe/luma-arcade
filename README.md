# LumaArcade

A thin login shell in front of your own [Sunshine](https://github.com/LizardByte/Sunshine) +
[ES-DE](https://es-de.org/) + [moonlight-web-stream](https://github.com/MrCreativ3001/moonlight-web-stream)
setup. LumaArcade itself is a small Node.js/TypeScript process that runs in
the system tray on your Windows gaming PC: it adds per-user access rules on
top of moonlight-web-stream's own sign-in, manages
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

Opening LumaArcade's `/` redirects to its `/stream` reverse proxy, i.e.
moonlight-web-stream's browser client. Its sign-in (moonlight-web-stream's
users and roles) is the only login; LumaArcade reads that session to decide
who may use which apps and the admin/settings API.

## Installing (the easy way)

Download `LumaArcadeSetup.exe` and run it. It asks:

1. **What to install**
   - *Everything* - Luma Arcade (with moonlight-web-stream bundled), Sunshine,
     ES-DE and emulators: play this PC's games from any browser.
   - *ES-DE and emulators* - a console-style library for playing on this PC
     with a TV and controller. No streaming, no Sunshine, no website.
   - *Just the emulators* - one folder with Start menu shortcuts.

   The next page lists every emulator, so you can untick the ones you don't
   want. ES-DE, the emulators and Sunshine are downloaded from their official
   releases at install time, so the PC must be online - the versions tested
   with Luma Arcade, listed with their checksums in
   `installer/scripts/versions.json` (a download that doesn't match its
   checksum isn't installed). BIOS/firmware files are never included.
2. **Which Windows** (detected for you). Normal Windows 10/11 is right for
   most people. Windows Server suits a PC that only hosts games, 24/7: no
   forced feature updates or surprise restarts, no consumer apps in the
   background, several people signed in at once over Remote Desktop, and
   GPU partitioning for virtual machines. The downsides: no Xbox 360
   controller driver, sound switched off, some anti-cheat and Store/Game
   Pass games won't run, and it costs more. On Server the installer turns
   sound on.
3. **This PC's hardware** (streaming installs). Warns when there's no
   NVIDIA, AMD or Intel graphics for Sunshine to encode with, offers the
   [Virtual Display Driver](https://github.com/VirtualDrivers/Virtual-Display-Driver)
   when no monitor is plugged in (with the screen sizes the stream page can
   ask for).
4. **Controllers**: whether players' controllers reach games as Xbox 360
   pads (recommended) or PlayStation 4 (DualShock 4) pads, and the drivers
   for them: [ViGEmBus](https://github.com/nefarius/ViGEmBus), the virtual
   controller driver either kind needs, and Microsoft's Xbox 360 controller
   driver (Windows Server lacks it; PlayStation 4 pads work without it).
5. **Which account runs it** (streaming installs only). A separate account
   (default name `Arcade`) is recommended: people who stream see and control
   that account's desktop - open windows, files, browser sessions, saved
   passwords - so a games-only standard account keeps your own account
   private. The installer creates it, can sign it in when the PC starts
   (Sunshine can only stream a signed-in desktop; the password is stored as
   an LSA secret like Sysinternals Autologon, not in plain text), and starts
   Luma Arcade when it signs in.
6. **Your admin account**: the first Luma Arcade account, and Sunshine's
   sign-in if it has none. Setup then pairs the two, so there's nothing to
   set up by hand afterwards.
7. **Playing from other devices**: HTTPS on the home network
   (`https://<this PC>:7778`, a certificate made for this PC - browsers only
   allow controllers and full screen on HTTPS pages), and optionally a
   Cloudflare Tunnel token for playing away from home.
8. **Folders**: Luma Arcade (`Program Files\LumaArcade`) and a games folder
   (`C:\Games`: `ES-DE\`, `ES-DE\Emulators\<name>` in the folder names
   ES-DE's portable find rules expect, `ES-DE\ROMs\`). Every account on the
   PC can use the games folder.

It also installs the PC-side half of Luma Arcade into
`C:\ProgramData\LumaArcade`: the scripts and scheduled tasks behind lockdown,
the Home button, the window picker, per-player saves, game tracking and the
focus fix, Sunshine's prep-cmd for ES-DE and Big Picture, and ES-DE's event
scripts (`installer/scripts/install-host.ps1`; `host.json` there says where
ES-DE, the emulators and the saves are).

Afterwards, `NEXT-STEPS.txt` (signing in, other devices) and
`READ ME - games setup.txt` (where games and BIOS files go) open. To add or
update emulators later, run `<games folder>\setup\install-games.ps1` as
administrator (`-Emulators retroarch,dolphin,...`, `-ListOnly` to check, `-Latest`
for the newest releases instead of the tested ones).

**Upgrading**: run the new `LumaArcadeSetup.exe`. It finds the installed copy,
stops it, replaces its files (keeping the database, moonlight's `data.json`
and `config.json`, and the HTTPS certificate), leaves already-installed
emulators unticked, and starts it again.

**Silent installs** (`/S`, for scripted setups), all options optional:

    LumaArcadeSetup.exe /S /TYPE=everything|esde|emulators /EMULATORS=all|none|retroarch,dolphin,...
        /GAMESDIR=D:\Games /ACCOUNT=Arcade|current /PASSWORDFILE=<file> /NOAUTOLOGON /NOAUTOSTART
        /ADMINFILE=<file: name and password on two lines> /NOHTTPS /TUNNELTOKENFILE=<file>
        /SERVER /CLIENT /VDD /NOVDD /VIGEM /NOVIGEM /XUSB /NOXUSB /DS4 /LATEST /D=C:\Program Files\LumaArcade

Secrets go in files (copied, never changed); `/D=` must come last. A new
games account needs `/PASSWORDFILE`: without one Setup stops with exit code
2 before changing anything. `Uninstall.exe /S` removes Luma Arcade
and keeps its data; add `/REMOVEAUTOLOGON` and/or `/REMOVEACCOUNT` to stop the
games account signing in / delete it (the uninstaller asks, otherwise).

## Host setup by hand (without the installer)

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
npm run dev:server   # Fastify auth + reverse proxy on :7777, restarts on change
npm test             # session lock, hand-over, queue, app access, play log
```

Point the `moonlightWebStreamPath` setting at your moonlight-web-stream
install, then open `http://localhost:7777/` and sign in with a
moonlight-web-stream account (an Admin one to reach Settings).

For a production-style single-process run:

```bash
npm run build
npm run start         # Fastify on :7777
```

7777 is only the default - the listen port is a setting (Settings -> General),
so a deployment may well be on something else.

## Building the Windows installer

```bash
npm run package        # requires NSIS (winget install NSIS.NSIS) and a system Node install to copy from
```

Produces `installer/output/LumaArcadeSetup.exe`, an admin install (Sunshine,
Windows accounts and the Server fixes need it). It bundles the built server,
a copied `node.exe`, production-only `node_modules`, and the customized
moonlight-web-stream from `../moonlight-web-stream-bin/package` (override
with `MOONLIGHT_PACKAGE_DIR`) - only its executables, `static\`, its config
(as `config.default.json`, with `session_cookie_secure` off for a first sign-in
over plain http), the TURN script and the PC-side helper scripts from its
`host\`; never `data.json` (users and pairing key), `cloudflare_turn.json` or
backups. On first start LumaArcade uses that bundled copy if no moonlight
path is set (`server/src/config/bundled.ts`).
`installer/LumaArcade.nsi` is the installer; `installer/scripts` holds the steps it
runs: `install-games.ps1`, `install-sunshine.ps1`, `install-drivers.ps1`,
`setup-windows.ps1`, `install-host.ps1`, `setup-network.ps1`, `first-run.mjs`
(admin account + pairing), `stop-luma.ps1` (upgrades), `uninstall-host.ps1`.

The download versions are pinned in `installer/scripts/versions.json`
(`catalog.ps1` says where each comes from). `update-versions.ps1` finds newer
releases, downloads and checks each one, and pins the good ones; the
"Tested versions" GitHub workflow runs it every Monday and opens a pull
request (it needs "Allow GitHub Actions to create and approve pull requests"
in the repository's Actions settings).

## Architecture notes

- **Auth**: moonlight-web-stream's sign-in. Its session cookie is scoped to
  `/stream`, so pages there call LumaArcade at `/stream/luma-api/...`
  (rewritten to `/api/...`); `requireAuth` / `requireAdmin` ask
  moonlight-web-stream who the cookie belongs to (`server/src/web/streamUser.ts`).
  Per-user app access and session rules live in LumaArcade's DB
  (`web/access.ts`, `web/appAccess.ts`, admin API in `web/routes/admin.ts`).
- **Running behind a tunnel** (e.g. cloudflared on this machine): Fastify
  trusts forwarding headers from loopback only (`server/src/web/requestOrigin.ts`),
  so the login rate limit is per real visitor (`CF-Connecting-IP`) instead of
  one shared bucket. Requests arriving through the tunnel
  count as "internet"; those can't change the settings that make the host execute a file or rebind
  (`moonlightWebStreamPath`/`Port`, `devTreePath`, `port`) - do those from
  the home network.
- **One PC, one player** (`server/src/web/sessions.ts`): whoever is
  streaming has the PC. Someone else who connects asks them to hand it
  over (`routes/handover.ts`): the streamer gets a notification with Hand
  over / ✕ that lapses after 10 seconds, and the asker sees the answer.
  Handing over closes the streamer's stream and lets the asker in; admins
  can also take over without waiting. A player whose stream page reports no
  input for 15 minutes hands over as soon as someone asks. A game left open
  with nobody streaming stops being its player's after 10 minutes (3 when
  someone is waiting), and anyone can then take it or close it. People can
  also wait in line: once the PC is free it's held 90 seconds for whoever
  is first, and their page connects them.
- **Play history** (`server/src/web/playLog.ts`, admin page's Play history
  tab): every stream's player, app, start and length, in the `play_sessions`
  table.
- **Per-player saves** (`host/profiles.ps1`, see `host/README.md`): a
  Sunshine prep-cmd swaps the emulators' save folders and ES-DE's
  favorites/play counts to whoever's stream is starting. Players snapshot
  and restore their own saves from Settings -> My saves (`routes/saves.ts`).
- **Co-op** (`sessions.ts`, `routes/coop.ts`): the person playing invites
  someone (quick panel -> Play together); the invite shows on their home
  screen, and they join the same screen as player 2 at the player's exact
  size and frame rate, controllers only. Needs `channels = 2` in
  `sunshine.conf`. Guests can't go Home, switch windows or close the game.
- **Stream page report** (every 30 s): idle time and stream quality
  (bitrate, fps, ping, dropped frames, loss) - shown per session in Play
  history - answered with play time left and announcements.
- **Play time limits** (`web/limits.ts`, admin -> person -> Play time):
  minutes per day/week; a stream is refused or ended once they're used up.
- **Announcements** (`web/announcements.ts`, admin -> Announcements): shown
  on everyone's home screen and popped up once on stream pages.
- **Guest links** (`web/guestLinks.ts`, `routes/guestLinks.ts`, admin ->
  Guest links, or Play together -> "Or send a link" for admins): `/g/<token>`
  for someone without an account, either their own turn on the PC or
  joining the creator's game as player 2. Each link has its own throwaway
  moonlight-web-stream account (made with the admin's session); opening the
  link signs the visitor in as it. Its play time and expiry count as a time
  limit, so warnings and the cut-off work as usual. Admins see who's playing,
  and can message, change time, kick or turn a link off (which deletes its
  account). New accounts only see PCs set to "Everyone", so the paired PC is
  shared that way.
- **Messages** (`web/messages.ts`): an admin can message anyone (person
  page or guest link); it pops up on their stream or home screen within a
  few seconds.
- **Host health** (Settings -> Host health, `server/src/web/routes/health.ts`):
  checks Sunshine's service (including whether its HTTPS port has hung,
  with a Restart Sunshine button) and encoders, moonlight-web-stream, whether the
  virtual-controller driver Sunshine needs is installed, whether anyone is
  logged into the console session, and whether ES-DE is running.
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
- **Auto-start** is a scheduled task (`\LumaArcade\LumaArcade`) that runs
  `LumaArcade.vbs --background` when the chosen account signs in, not a
  Windows Service - it runs in that account's session, next to the games.
  `--background` skips opening the portal in a browser, which would pop up
  on the streamed desktop.
- **Remote/WAN access**: LumaArcade itself is LAN-only - there's no bundled
  tunnel or TURN relay anymore. If you want to play from outside your LAN,
  that's handled by however you expose Sunshine/moonlight-web-stream
  (port-forwarding, your own VPN/tunnel, etc.), not by LumaArcade.

## Troubleshooting

Start with Settings -> Host health; most of the issues below show up there.

**The stream works but the controller does nothing in ES-DE/games (Windows
Server hosts).** Sunshine emulates Xbox 360 pads through ViGEmBus, but
Windows Server doesn't ship the Xbox 360 controller driver (`xusb22.sys`),
so the virtual pads appear in Device Manager with no driver and no app ever
sees them. Either install that driver, or set `gamepad = ds4` in
`sunshine.conf` (PS4 emulation uses the built-in HID driver - fine for ES-DE
and RetroArch, but Xbox-only PC games won't see it).

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
