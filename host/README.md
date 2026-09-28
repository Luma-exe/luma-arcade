# Host scripts

## Per-player saves (`profiles.ps1`)

Gives everyone who streams their own emulator saves and their own ES-DE
favorites / play counts / last played / completed flags, on the one shared
gaming PC.

How it works: Sunshine runs `profiles.ps1` (the first prep-cmd of the ES-DE
app) just before it starts ES-DE. The script asks LumaArcade
(`GET http://127.0.0.1:<port>/api/profiles/current`, answered only for
requests from the PC itself) whose stream is starting, then:

- swaps each save folder listed in the script: the one in use is renamed to
  `<folder>.profiles\<its owner>`, and the player's is renamed to
  `<folder>`. Renames on the same drive are instant, and they work on the
  exFAT games drive (G:), which can't hold junctions or symlinks. The first
  time, the folder becomes `<folder>.profiles\_shared` - the saves everyone
  had until then - and a new player's saves start as a copy of it (save
  states start empty).
- saves the previous player's ES-DE stats to
  `C:\ProgramData\LumaArcade\profiles\user-<id>\esde-stats.json` and writes
  this player's into the game lists.

Which player's saves each folder holds is in
`C:\ProgramData\LumaArcade\profiles\state.json`, written after every step.
It does nothing while ES-DE or any emulator is still running (a game left
open and taken over keeps saving where it was), and nothing when the same
person plays again. Log: `C:\ProgramData\LumaArcade\profiles\profiles.log`.
Host Health's "Player saves" row shows who is loaded and any problem.

Left shared on purpose: Azahar (3DS) and Xenia keep installed games/DLC next
to their saves, and xemu's saves live in one disk image.

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
`-DryRun` only logs.
