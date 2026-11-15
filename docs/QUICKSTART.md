# Quick start

Turn your Windows gaming PC into a private arcade your friends can play from a browser. It takes about 20 minutes, most of it Setup downloading things.

## What you need

- **A gaming PC** running Windows 10 (version 2004 / 20H1 or newer) or Windows 11, 64-bit, and an administrator account on it.
- **A graphics card with a hardware video encoder.** Nearly every gaming PC has one: NVIDIA (NVENC), AMD (VCE/VCN) or Intel (Quick Sync, 6th-gen Core or newer).
- **Internet during Setup.** It downloads Sunshine, ES-DE and the emulators.
- **Optional, to play from outside your home:** a free [Cloudflare](https://www.cloudflare.com/) account and a domain name on it. Setup asks for a tunnel token. You don't open any ports on your router. Skip this and the arcade works on your home network only.

Players need only a browser (Chrome or Edge work best) on a TV, laptop, phone or tablet. About 10-15 Mbps of upload from your home per player is a good guide.

## 1. Download and run Setup

Download `LumaArcadeSetup.exe` from the [latest release](https://github.com/Luma-exe/luma-arcade/releases/latest/download/LumaArcadeSetup.exe) and double-click it.

**Windows may say "Windows protected your PC".** The installer isn't code-signed yet, so Windows doesn't recognise it. Click **More info**, then **Run anyway**. Then click **Yes** on the administrator prompt.

## 2. Go through the Setup pages

Click **Next** on each page. The defaults suit most people.

1. **Welcome**
2. **License** (GPL-3.0)
3. **What do you want to install?** Pick *Everything* to stream games from this PC. A list on the next page lets you choose emulators.
4. **Which Windows is this?** Setup detects it. On Windows Server it offers a few extra fixes.
5. **This PC's hardware.** Shows whether Setup found a graphics encoder, and offers a virtual display if no monitor is plugged in.
6. **Controllers.** Virtual Xbox 360 or PlayStation 4 controllers, so players' pads work in games.
7. **Which Windows account should run the games?** A separate account that signs in by itself keeps players away from your own desktop.
8. **Your admin account.** The name and password (at least 8 characters) you will sign in to Luma Arcade with. Make it a strong one if the arcade will be on the internet.
9. **Playing from other devices.** HTTPS for your home network, and an optional Cloudflare Tunnel token for playing away from home.
10. **Extra seats.** Optional, for more people playing at once. Leave it off to start with.
11. **Luma Arcade folder** and **Games folder.** Where the program goes, and where ES-DE, the emulators and your games go. Pick a drive with plenty of space for the games.
12. Setup installs everything and ends on **You're all set**.

## 3. Sign in

Open **http://localhost:7777** on the gaming PC and sign in with the admin account you made in Setup. Setup already linked Luma Arcade to Sunshine, so the PC's games (ES-DE, Desktop, Steam Big Picture) are ready. Put your games in the games folder; "READ ME - games setup.txt" there says where BIOS files and ROMs go.

Skipped the admin account, or pairing didn't work? `NEXT-STEPS.txt` in the install folder explains how to pair by hand.

## 4. Play from another device

- **At home:** on any device on your network, open `https://<this PC's name or IP>:7778`. Each device warns about the certificate once: choose Advanced, then Proceed. Browsers only allow game controllers and full screen on secure pages, so use this address and not plain `http://` on port 7777.
- **Away from home:** in the Cloudflare dashboard (Zero Trust, Networks, Tunnels, your tunnel, Public hostname), point a hostname at `http://localhost:7777`.

## 5. Invite players

- **People with an account:** as the admin, create accounts for your friends and give them the address, their name and a password.
- **People without one:** make a **guest link**. It lets a friend have a turn, or join your game, for a time limit you choose, and ends by itself. You can see who is using one, message them, or switch it off.
- **Inside a game:** use the **People** panel to invite someone straight into the game you are playing.

### Private mode

New installs start with **private mode on**. The front page doesn't offer a "request an account" or "forgot password" form, and nothing from visitors is stored. Only accounts and links you create work. To let visitors ask for an account, turn private mode off in **Settings** (as the admin). Their requests then reach you (and a Discord channel, if you set up a webhook). See [PRIVACY.md](PRIVACY.md) for what that stores.

## Getting help

- **Troubleshooting** is in the [README](../README.md#troubleshooting). Host health in Settings (as the admin) checks Sunshine, the drivers and the helper scripts.
- **Questions or bugs:** [open an issue](https://github.com/Luma-exe/luma-arcade/issues) on GitHub.
- **New PC or backup:** [MOVING.md](MOVING.md).
- **What the arcade stores and sends:** [PRIVACY.md](PRIVACY.md).
