# Backing up and moving your arcade

`arcade-backup.ps1` saves your arcade into one zip file and restores it, either on the same PC after a reinstall or on a new PC.

## What is in the backup

| What | Where it lives |
|---|---|
| Luma Arcade's database: accounts, settings, guest links, play history | `<install folder>\server\luma-arcade.db` |
| moonlight-web-stream's users and paired PCs, and its settings | `<install folder>\moonlight-web-stream\server\data.json` and `config.json` |
| Every player's game saves | `C:\ProgramData\LumaArcade\profiles` |
| This PC's folder paths for ES-DE, emulators and saves | `C:\ProgramData\LumaArcade\host.json` |

Logs are left out. Your games, ROMs, BIOS files and emulators are not in the backup (they are large and Setup puts the emulators back). Copy your games folder across yourself.

The zip holds your accounts and players' saves: keep it somewhere private.

## Make a backup

1. Stop Luma Arcade. Copying its database while it runs can give a damaged copy, so the script refuses unless it is stopped. Easiest: restart the PC and run the script before anyone signs in, or end the **LumaArcade** task in Task Scheduler (Task Scheduler Library, `LumaArcade` folder).
2. Open PowerShell **as administrator** and run:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Program Files\LumaArcade\host\arcade-backup.ps1" -Action export -To D:\arcade-backup.zip
```

Use the script's own folder if it is somewhere else. If you installed Luma Arcade somewhere other than `C:\Program Files\LumaArcade`, Windows' list of installed programs tells the script where. If that fails, add `-InstallDir "<your folder>"`.

Add `-DryRun` to see what would be saved without writing anything. `-Force` makes the backup while Luma Arcade is running; only use it if you accept that the database copy may be damaged.

## Move to a new PC

1. On the old PC, make a backup as above, and copy the zip to the new PC.
2. On the new PC, run `LumaArcadeSetup.exe` (see the [quick start](QUICKSTART.md)) and finish Setup. Use the same games account name if you can, so saves match.
3. Copy your games folder across.
4. On the new PC, in an administrator PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Program Files\LumaArcade\host\arcade-backup.ps1" -Action import -From D:\arcade-backup.zip
```

Import stops Luma Arcade, keeps what it replaces in `C:\ProgramData\LumaArcade\import-backup-<date and time>`, restores the files, and starts Luma Arcade again (add `-NoStart` to leave it stopped). `host.json` is not restored unless you add `-RestoreHostSettings`: it holds the old PC's folder paths, and the new PC's Setup has already written the right ones. Use that switch only when restoring onto the same PC layout.

5. Finish the move:
   - Sign in at `http://localhost:7777` with your usual admin account.
   - Pair again. The old PC's Sunshine pairing doesn't carry over: in the arcade, remove the old PC and add this one (address `localhost`), then type the PIN into Sunshine at `https://localhost:47990`.
   - If you use a Cloudflare Tunnel, Setup on the new PC made its own. Point your hostname at it in the Cloudflare dashboard, and turn the old PC's tunnel off.
   - Players keep their accounts and saves. Ask them to sign in once to check.

## Restoring on the same PC

Reinstall with Setup (or use **Repair**), then run the import command above. Nothing else is needed.

## Problems

- *"Luma Arcade is running"* on export: stop it as described above.
- *"Run this from an administrator PowerShell"*: right-click PowerShell and choose Run as administrator.
- Something looks wrong after an import: everything it replaced is in the `import-backup-...` folder inside `C:\ProgramData\LumaArcade`. Stop Luma Arcade and copy the files back.
