# Plan: Luma Arcade on a Linux host

**Status:** phase 1 is in **very early testing**: `installer/linux/install.sh` installs the server, moonlight-web-stream (upstream v2.10.0's Linux build with Luma Arcade's web files) and a portable Node as a systemd user service; installing, upgrading, signing in and Host health are tested on Ubuntu 24.04; streaming from a real Linux gaming PC is not confirmed yet. Server tests run on Ubuntu in CI. **Goal:** a Linux gaming PC can host Luma Arcade with the same promise as Windows: send a link, and your friend is playing in their browser.

Why it matters: most self-hosters run Linux (r/selfhosted, Bazzite, ChimeraOS, Steam Deck owners), and Sunshine already runs well there.

## What's Windows-only today

Most of the hard parts already run on Linux. The browser client, the Node server, Sunshine and moonlight-web-stream all do. What doesn't is the glue between the server and the gaming PC's desktop.

| Piece | Today (Windows) | On Linux |
|---|---|---|
| Web server (Node, Fastify, SQLite) | runs anywhere | **works as-is**, apart from Windows paths (`C:\ProgramData\LumaArcade`) and a few `powershell.exe` calls |
| moonlight-web-stream (Rust) | `web-server.exe`, `streamer.exe` | builds for Linux - upstream has a Docker setup; our changes need building there too |
| Sunshine | Windows service | **native** (systemd user service), KMS / X11 / wlroots capture |
| Virtual controllers | ViGEmBus + Xbox 360 driver | **not needed** - Sunshine uses `uinput` |
| Virtual display (no monitor) | Virtual Display Driver | a headless compositor (gamescope, Sway) or a kernel EDID override |
| Games account that signs in by itself | Windows account + AutoAdminLogon | a dedicated user + display-manager autologin |
| Helper scripts on the games desktop | ~2,400 lines of PowerShell, run by scheduled tasks | **the real work** - see below |
| Lockdown (guests can't reach settings) | closes admin tools by window title | mostly unnecessary in a kiosk session (gamescope shows one app) |
| ES-DE + emulators | portable ES-DE, Windows emulator builds | ES-DE AppImage, emulators as AppImage / Flatpak |
| PC games import | Steam + Epic manifests | Steam (`~/.steam/steam/steamapps`, the same `.acf` files) + Heroic for Epic/GOG |
| Extra seats | Hyper-V VMs with GPU partitions | **easier**: containers sharing the GPU (see [Wolf](https://github.com/games-on-whales/wolf)) |
| Installer | NSIS `.exe` | an install script first; `.deb` / Flatpak / AUR later |
| Host health checks | `qwinsta`, drivers, Windows services | `loginctl`, `systemctl`, `/dev/uinput`, `vainfo` / `nvidia-smi` |

## The approach: move logic into the server, keep the per-OS part small

Most of the PowerShell doesn't need the desktop session. It moves files and edits XML:
- `profiles.ps1`: per-player saves (684 lines; renames folders and edits ES-DE game lists)
- `sync-pc-games.ps1`: Steam and Epic import
- `seat-sync.ps1`: moving saves between seats

Rewriting those in TypeScript inside the server makes them **cross-platform, unit-testable, and simpler on Windows too**. That's worth doing even if Linux never ships.

What really needs the desktop stays as small per-OS helpers behind one interface:

```ts
interface HostDesktop {
  focusApp(name: string): Promise<void>;     // Home button, window picker
  listWindows(): Promise<Window[]>;
  closeGame(pid: number): Promise<void>;
  lockdown(on: boolean): Promise<void>;      // no-op in a kiosk session
  consoleSession(): Promise<SessionInfo>;    // who's signed in on the screen
}
```

Windows keeps its PowerShell (through the scheduled tasks, as now). Linux gets a small helper running in the games user's session (`swaymsg` / `wmctrl` / gamescope's own controls).

## Phases

**Phase 0 - cleanup on Windows (no visible change; about 1-2 weeks)**
1. One setting for the data folder instead of `C:\ProgramData\LumaArcade` written into the code. Also fix `games.ts`, which has `G:\ES-DE\downloaded_media` hard-coded, so cover art also works on other PCs - read it from `host.json`.
2. Put the desktop calls (`home.ts`, `lockdown.ts`, `input.ts`, `health.ts`) behind `HostDesktop`.
3. Port `profiles.ps1` and `sync-pc-games.ps1` to TypeScript, with tests, keeping the same on-disk layout so existing saves carry over.
4. Make the CI run the server tests on Ubuntu as well as Windows.

**Phase 1 - Linux MVP: streaming, accounts and links (about 2-3 weeks)**
- Supported setup: a recent Ubuntu or Fedora, NVIDIA or AMD, Sunshine from its `.deb` / `.rpm`, ES-DE AppImage, one games user with autologin into a **gamescope session** (or Sway headless).
- An `install.sh` that installs the server + moonlight-web-stream as a systemd service, pairs it with Sunshine, and creates the admin account (the same steps as `first-run.mjs`).
- Working: sign-in, turns, co-op, guest links (including links that open straight into a game), time limits, play history, Steam import, Host health with Linux checks.
- Not yet: per-player saves, lockdown, extra seats.

**Phase 2 - parity (about 2-3 weeks)**
- Per-player saves on Linux (the TypeScript port from phase 0, plus emulator save paths for the AppImage / Flatpak builds).
- Home button and window picker in the gamescope / Sway session.
- Heroic (Epic, GOG) import.

**Phase 3 - extra seats on Linux (a separate project)**
- Containers sharing the GPU, one Sunshine per seat - the [Wolf](https://github.com/games-on-whales/wolf) model. Far simpler than Hyper-V GPU partitioning, and could become the best multi-player story on either OS.

**Phase 4 - packaging and reach**
- A Docker image for the server + moonlight-web-stream (Sunshine stays on the host).
- AUR package, then Flatpak or `.deb`. A guide for Bazzite / ChimeraOS, whose users already run gamescope sessions.

## Decisions to make first

1. **Desktop session.** gamescope (what SteamOS and Bazzite use: one fullscreen app, simplest for a console) or Sway headless (more general, easier window control)? *Recommendation: gamescope*, since the people most likely to try this already run it.
2. **Supported distros for phase 1.** *Recommendation: Ubuntu LTS and Fedora / Bazzite only*, and say so in the README. Every extra distro is more support work.
3. **Wolf.** It already does multi-user Linux streaming with containers. Build on it for seats, or stay with plain Sunshine? Worth a look before phase 3.

## Risks

- **Wayland is fragmented.** Window control differs per compositor, which is why the plan picks one session type.
- **Emulator save locations** differ between AppImage, Flatpak and native packages, and per-player saves depend on knowing them.
- **NVIDIA on Wayland** still has rough edges with capture and encoding. Test on both vendors before announcing.
- **Support load.** "Linux" means many setups. A narrow supported list, and the "Copy diagnostics" report adapted for Linux, keep it manageable.
