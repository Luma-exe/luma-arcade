# Privacy: what Luma Arcade stores and sends

Luma Arcade runs on your own PC. There is no Luma Arcade company server collecting anything: no sign-up elsewhere, no analytics, no telemetry. This page lists what is stored on your PC and the few places data leaves it. If you run the arcade for friends, this is what to tell them.

## Stored on the PC

- **Accounts and settings.** Names, password hashes, who may play and when, guest links, play history and settings are in the arcade's SQLite database (`luma-arcade.db`, in the `server` folder of the install folder). moonlight-web-stream keeps its users and paired PCs in `data.json`, next to its `config.json`.
- **Visitor IP addresses, for account and password-reset requests.** When private mode is **off**, the front page offers "request an account" and "forgot password" forms. Each request is stored with the visitor's IP address and the name, contact and message they typed. The IP lets the arcade accept one account request per visitor and one password-reset request per visitor per day. There is also an hourly cap across everyone. With private mode **on** (the default on new installs) these forms are refused and nothing is stored. See `server/src/web/routes/welcome.ts`.
- **Where the IP comes from.** For direct connections it is the connecting address. For connections through the Cloudflare Tunnel, which connects from the PC itself, it is taken from Cloudflare's `CF-Connecting-IP` header, and only when the connection really comes from the PC itself (`server/src/web/requestOrigin.ts`).
- **Rate limits.** Sign-in and guest-link attempts are limited per address (too many failures means a one-minute wait). Those counters live in memory only and vanish when the arcade restarts.
- **Per-player game saves** are kept in `C:\ProgramData\LumaArcade\profiles`.
- **Logs, local only.** The server log is `logs\server.log` in the data folder (`C:\ProgramData\LumaArcade` on Windows). It is rotated at 10 MB, keeping the three most recent old files (`server.log.1` to `.3`). Request lines in it can include the connecting address. The helper scripts' logs (in the data folder's `home` and `profiles` folders) are rotated at 2 MB, keeping one old file. Logs are never sent anywhere, and you can delete them at any time.

A backup made with `arcade-backup.ps1` ([MOVING.md](MOVING.md)) contains the database and saves, so keep that file private.

## Sent out

- **Discord, only if you set a webhook.** In Settings the admin can enter a Discord webhook URL. While it is empty, nothing is sent. When set, the arcade posts short messages to your channel: account and password-reset requests (the name, Discord handle and message the visitor typed, not their IP address), "X started playing", someone asking for the PC or waiting for it, a stream ended for being idle, and health warnings such as Sunshine being restarted. They go straight from your PC to Discord (`server/src/web/notify.ts`), and Discord's privacy policy applies to them.
- **The update check calls GitHub.** The admin's update screen asks `api.github.com` for the newest Luma Arcade release, at most once an hour. GitHub sees your PC's public IP address, as with any web request. No account names, settings or play data are sent (`server/src/remote/updateCheck.ts`).
- **Cloudflare, if you use the tunnel.** If you give Setup a Cloudflare Tunnel token, web traffic from players away from home passes through Cloudflare's network on the way to your PC. Cloudflare ends the HTTPS connection, so it can see that traffic, and its privacy policy applies. Without a tunnel, nothing passes through Cloudflare.
- **Connecting a stream.** moonlight-web-stream's default settings (`config.json`) list Google's public STUN servers (`stun.l.google.com`), which help a browser and your PC find each other. The video itself goes between the player and your PC.
- **Setup downloads.** The installer fetches Sunshine, ES-DE, emulators and drivers from their official release pages, which see your IP address like any download.

Luma Arcade's own code makes no other requests to the internet.

## Your choices

- Keep **private mode** on to store no visitor data at all.
- Leave the Discord webhook empty to send nothing to Discord.
- Skip the Cloudflare token to keep the arcade on your home network.
- Delete `logs\server.log*` whenever you like.
- Delete a person's account in the arcade to remove their account. Uninstalling removes the program; Setup offers to keep a backup of your accounts and settings.
