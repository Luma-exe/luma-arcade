# Host scripts

## Per-player saves (`profiles.ps1`)

Gives everyone who streams their own emulator saves and their own ES-DE
favorites / play counts / last played / completed flags, on the one shared
gaming PC.

How it works: Sunshine runs `profiles.ps1` (the first prep-cmd of the ES-DE
app) just before it starts ES-DE. Sunshine only does that when it STARTS
ES-DE, so the stream page first asks LumaArcade to get the saves ready
(`POST /api/sessions/prepare`, server `web/savesReady.ts`): an ES-DE session
running with someone else's saves is closed, and starts again for the new
player. The script asks LumaArcade
(`GET http://127.0.0.1:<port>/api/profiles/current`, answered only for
requests from the PC itself) whose stream is starting, then:

- swaps each save folder listed in the script: the one in use is renamed to
  `<folder>.profiles\<its owner>`, and the player's is renamed to
  `<folder>`. Renames on the same drive are instant, and they work on the
  exFAT games drive (G:), which can't hold junctions or symlinks. The first
  time, the folder becomes `<folder>.profiles\_shared` - the saves everyone
  had until then. A new player starts with empty saves (only Vita3K's user
  profile, and Xenia's gamer profiles without their saves, are copied), so
  nobody gets someone else's progress.
- saves the previous player's ES-DE stats to
  `C:\ProgramData\LumaArcade\profiles\user-<id>\esde-stats.json` and writes
  this player's into the game lists.

Which player's saves each folder holds is in
`C:\ProgramData\LumaArcade\profiles\state.json`, written after every step.
It does nothing while ES-DE or any emulator is still running (a game left
open and taken over keeps saving where it was), and nothing when the same
person plays again. Log: `C:\ProgramData\LumaArcade\profiles\profiles.log`.
Host Health's "Player saves" row shows who is loaded and any problem.

Covered: RetroArch, Dolphin (GC/Wii), PCSX2, DuckStation, PPSSPP, RPCS3, Cemu,
Eden (Switch), Vita3K, Supermodel, shadPS4, melonDS, Flycast, ScummVM, Azahar
(3DS: its virtual SD card; games run from .cci files, so it only holds saves),
EasyRPG, DOSBox Staging, Xenia and xemu:

- melonDS, Flycast and ScummVM were pointed at `saves`/`states` folders in
  their own folder (2026-10-01; backups `*.bak-20261001-saves`).
- EasyRPG and DOSBox Staging games start through `launchers\` (copied next to
  `Player.exe` / `dosbox.exe`; ES-DE uses them through
  `C:\Users\Arcade\ES-DE\custom_systems\es_systems.xml`, backup
  `.bak-20261001-saves`). EasyRPG gets `--save-path saves\<game>`; DOSBox
  mounts an overlay on C: at `saves\<game>`, so the game's folder is never
  written to and everything it saves lands there. `.conf`, disc/disk images
  and zips still start the plain way (saves shared).
- Xenia: each gamer profile's folder (`content\<XUID>`) is a slot of its own,
  put away in `content-profiles\<XUID>` (outside `content\`, so Xenia never
  mistakes one for a profile). `content\0000000000000000` (DLC, title
  updates) stays shared. A profile made later belongs to whoever made it.
- xemu: its disk image folder `G:\BIOS\XBOXOG\hdd` is swapped, and new
  players start from a clean image in `G:\BIOS\XBOXOG\hdd-clean`. Until that
  folder exists, xemu stays shared. Left out of snapshots (1 GB).

Not covered: Steam and other PC games (their saves follow the Steam account or
the game).

### Snapshots

Players can snapshot their saves from the stream page's settings ("My
saves"), and restore one when no game is running. LumaArcade runs
`profiles.ps1 -Action snapshot|list|restore`; snapshots go to
`E:\GameSaveBackups\snapshots\user-<id>\<time>`, 10 per player. Restoring
first snapshots what's there now ("Before restoring").

The nightly backup (`E:\GameSaveBackups\backup-saves.ps1`) copies every
`.profiles` folder and the ES-DE stats too.

### Guest links becoming accounts

The admin screen's Guest links -> **Make account** creates a real account
and runs `profiles.ps1 -Action transfer -From <guest id> -To "<id>:<name>"`:
the guest's save folders (renamed, or relabelled in `state.json` if they're
the ones in use), their ES-DE stats and their snapshots become the new
account's. It checks every destination is free before moving anything, and
refuses an account that already has saves. LumaArcade then moves their play
history and turns the guest link off.

### Setup (done 2026-09-28)

1. `C:\ProgramData\LumaArcade\profiles` must be writable by the Arcade
   account (the prep-cmd runs as it) - it was created with
   `icacls ... /grant Arcade:(OI)(CI)M`.
2. Copy `profiles.ps1` to `C:\ProgramData\LumaArcade\profiles.ps1`.
3. In `C:\Program Files\Sunshine\config\apps.json`, the **first** `prep-cmd`
   of the ES-DE app (Sunshine waits for it, so ES-DE starts with the right
   saves):

       powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\ProgramData\LumaArcade\profiles.ps1 -Port 4500

   `-Port` is LumaArcade's port. Restart the Sunshine service after editing,
   while nobody is streaming.

### Turning it off again

Remove the prep-cmd: whoever played last keeps their saves in the normal
folders. To give everyone the old shared saves back, rename each
`<folder>.profiles\_shared` back to `<folder>` (after moving that player's
folder out of the way).

### Testing

`-TestRoot <folder>` runs against a copy of the layout under that folder
(`Emulators\`, `Roaming\`, `gamelists\`, `profiles\`, `snapshots\`) instead
of the real paths; `-Player "<id>:<name>"` skips asking LumaArcade;
`-DryRun` only logs. `test-profiles.ps1` runs a switch scenario (Xenia
profiles, DLC, xemu with and without a clean image, snapshots) against a
throwaway layout and prints ok/FAIL per check.

### On a PC set up by the installer

The installer (`installer/scripts/install-host.ps1`) copies these scripts,
and moonlight-web-stream's `host\` ones, to `C:\ProgramData\LumaArcade`,
sets up the prep-cmd and the scheduled tasks, and writes
`C:\ProgramData\LumaArcade\host.json` with where things are on that PC
(`esDe`, `esDeDir`, `gamelists`, `emulators`, `roaming`, `snapshots`, `bios`).
`profiles.ps1` and `home.ps1` use it instead of the original gaming PC's
paths above (without it, nothing changes). Dolphin and Cemu saves are taken
from their own folder when they're portable (`portable.txt` / `portable\`),
as the installer sets them up.

## Minimizing ES-DE during games (`esde-game-started.ps1`)

An ES-DE game-start event script (`<ES-DE data>\scripts\game-start\01-minimize-es-de.bat`
runs it): once a game has held the foreground for 3 seconds it minimizes
ES-DE, which otherwise catches a held stick direction during a focus bounce
and scrolls sideways forever behind the game; when only the desktop is left
it brings ES-DE back. Needs ES-DE's `CustomEventScripts` setting. Deployed
copy: `C:\ProgramData\LumaArcade\esde-game-started.ps1`.

## Switch, Wii and GameCube games fill the screen (`emulator-window.ps1`)

Eden (`user\config\window_state.ini`) and Dolphin (`Config\Qt.ini`) save
their window's place and size and put it back next time. The PC's screen
changes size with every player's stream, so after someone played at another
size the next game opened off to the side. The ES-DE game-start script
`00-emulator-window.bat` (switch, wii, gc only) clears the saved place and
size before the emulator starts, then watches in the background: a
fullscreen window that doesn't cover the screen is put over the whole
screen. Log: `C:\ProgramData\LumaArcade\home\emulator-window.log`.

## Quitting ES-DE (`esde-keepalive.ps1`)

Sunshine's ES-DE app starts `esde-keepalive.ps1 -Exe "<ES-DE.exe>"` instead
of ES-DE itself. If a player picks "Quit ES-DE" while someone is streaming,
ES-DE is started again 7 seconds later, instead of leaving them on the
desktop with the stream ended. Sunshine closing the app (Stop, idle close,
saves switch) ends this script within its 5-second exit timeout, before it
would restart anything; with nobody streaming it just ends.
Log: `C:\ProgramData\LumaArcade\home\esde-keepalive.log`.

## Extra seats (`seat-manager.ps1`, `seat-guest.ps1`, `seat-sync.ps1`)

More people playing at once, each on a Hyper-V virtual machine with a slice of
the graphics card (README: *Extra seats*). Settings > Extra seats drives it.

- **`seat-manager.ps1`** runs as SYSTEM (task `\LumaArcade\Seats`, at startup
  and whenever the website starts it): the website drops requests in
  `C:\ProgramData\LumaArcade\seats\requests` (writable by the games account
  only), it answers in `seats\responses` and keeps `seats\status.json`
  current. Each job runs as its own process. With no seats it stops after 15
  idle minutes. Logs: `seats\logs\<SeatN>.log` and `manager.log`.
- **Building a seat** (`create`): checks this PC, writes an unattended
  Windows answer file (an admin account `LumaAdmin` for PowerShell Direct, the
  standard games account `Arcade` signing in by itself), creates the VM with
  the GPU partition, waits for Windows, copies the host's display driver into
  `System32\HostDriverStore`, then runs `seat-guest.ps1` inside it: ES-DE and
  the emulators copied from the read-only games share (ROMs, media and BIOS
  stay on it), Setup's own `install-sunshine.ps1` / `install-drivers.ps1` /
  `install-host.ps1`, Mesa for OpenGL/Vulkan, lockdown always on, and Luma
  Arcade's client certificate trusted by Sunshine. Every step is noted in
  `seats\<SeatN>\seat.json`, so a failed or interrupted build carries on from
  where it stopped. Passwords are in `seats\<SeatN>\credentials.json`
  (administrators only).
- **Saves** moving to or from a seat go through the manager too (`sync`),
  with folders it picks itself: `seats\staging\user-<id>` (seat -> PC) and
  `sync-out\user-<id>` (PC -> seat). `seat-sync.ps1` is the older direct way,
  used when the manager isn't installed and Luma Arcade runs as an admin.
- **Uninstalling** with "Extra seats" ticked runs `-Action teardown`: the
  seats Luma Arcade built, the games share and its account. Hyper-V stays.
