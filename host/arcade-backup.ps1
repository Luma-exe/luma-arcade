<#
  Back up a Luma Arcade, or move it to another PC.

    powershell -ExecutionPolicy Bypass -File arcade-backup.ps1 -Action export -To D:\arcade-backup.zip
    powershell -ExecutionPolicy Bypass -File arcade-backup.ps1 -Action import -From D:\arcade-backup.zip

  What goes in the zip (logs are left out):
    luma-arcade.db (+ -wal/-shm)  Luma Arcade's accounts, settings, PCs, play history
                                  (<install folder>\server\)
    moonlight\data.json           moonlight-web-stream's users and paired PCs
    moonlight\config.json         moonlight-web-stream's settings
                                  (<install folder>\moonlight-web-stream\server\)
    profiles\                     per-player game saves (<ProgramData>\LumaArcade\profiles)
    host.json                     where this PC keeps ES-DE, the emulators and saves

  export  Copying a SQLite database while Luma Arcade writes to it can give a
          broken copy, so export refuses while Luma Arcade is running (stop it
          first: Start menu > Stop Luma Arcade, or end the "LumaArcade" task in
          Task Scheduler), unless -Force is given.
  import  Stops Luma Arcade, keeps what it replaces in
          <ProgramData>\LumaArcade\import-backup-<date>, restores the files
          and starts Luma Arcade again (-NoStart to leave it stopped).
          host.json is only restored with -RestoreHostSettings: it holds this
          PC's folder paths, which a new PC's Setup has already got right.
  -DryRun lists what would be done and changes nothing.
  -InstallDir  the Luma Arcade install folder (default: from Windows' list of
               installed programs, else C:\Program Files\LumaArcade)
  Needs an administrator PowerShell. See docs/MOVING.md.
#>
param(
    [Parameter(Mandatory)][ValidateSet('export', 'import')][string]$Action,
    [string]$To = '',
    [string]$From = '',
    [string]$InstallDir = '',
    [switch]$Force,
    [switch]$NoStart,
    [switch]$RestoreHostSettings,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Say([string]$t) { Write-Output $t }
function Fail([string]$t) { Write-Error $t; exit 1 }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail 'Run this from an administrator PowerShell (right-click PowerShell > Run as administrator).'
}

$DataDir = Join-Path $env:ProgramData 'LumaArcade'
if (-not $InstallDir) {
    $reg = Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\LumaArcade' -ErrorAction SilentlyContinue
    $InstallDir = if ($reg -and $reg.InstallLocation) { $reg.InstallLocation } else { Join-Path $env:ProgramFiles 'LumaArcade' }
}
$InstallDir = $InstallDir.TrimEnd('\')
$DbDir = Join-Path $InstallDir 'server'
$MoonDir = Join-Path $InstallDir 'moonlight-web-stream\server'
if (-not (Test-Path -LiteralPath $DbDir) -and -not (Test-Path -LiteralPath $MoonDir)) {
    Fail "Luma Arcade isn't installed in $InstallDir. Run Setup first (or pass -InstallDir)."
}

# Luma Arcade's own programs (not the Cloudflare tunnel) running from the install folder.
function Get-LumaProcesses {
    $root = $InstallDir + '\'
    @(Get-CimInstance Win32_Process | Where-Object {
            $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and
            $_.Name -in 'node.exe', 'web-server.exe', 'streamer.exe'
        })
}

function Stop-Luma {
    & schtasks.exe /end /tn '\LumaArcade\LumaArcade' 2>$null | Out-Null
    # node.exe first, so it doesn't restart moonlight-web-stream behind us.
    foreach ($name in 'node.exe', 'web-server.exe', 'streamer.exe') {
        foreach ($p in (Get-LumaProcesses | Where-Object Name -eq $name)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    for ($i = 0; $i -lt 20 -and (Get-LumaProcesses); $i++) { Start-Sleep -Milliseconds 500 }
    if (Get-LumaProcesses) { Fail "Couldn't stop Luma Arcade. Close it and try again." }
}

# The files that make up an arcade: zip entry name -> where it lives on this PC.
$Items = @(
    @{ Entry = 'luma-arcade.db';     Path = Join-Path $DbDir 'luma-arcade.db' },
    @{ Entry = 'luma-arcade.db-wal'; Path = Join-Path $DbDir 'luma-arcade.db-wal' },
    @{ Entry = 'luma-arcade.db-shm'; Path = Join-Path $DbDir 'luma-arcade.db-shm' },
    @{ Entry = 'moonlight/data.json';   Path = Join-Path $MoonDir 'data.json' },
    @{ Entry = 'moonlight/config.json'; Path = Join-Path $MoonDir 'config.json' },
    @{ Entry = 'host.json'; Path = Join-Path $DataDir 'host.json' }
)
$ProfilesDir = Join-Path $DataDir 'profiles'

# ------------------------------------------------------------------ export
if ($Action -eq 'export') {
    if (-not $To) { Fail 'Say where to save it: -To D:\arcade-backup.zip' }
    $To = [IO.Path]::GetFullPath($To)
    if (Test-Path -LiteralPath $To) { Fail "$To already exists. Pick another name." }
    $running = Get-LumaProcesses
    if ($running -and -not $Force) {
        Fail "Luma Arcade is running, and copying its database while it runs can give a broken copy. Stop it first (end the 'LumaArcade' task in Task Scheduler, or reboot and run this before anyone signs in), or add -Force if you accept that risk."
    }
    if ($running) { Say 'WARNING: -Force given while Luma Arcade runs: the database copy may be inconsistent.' }

    $stage = Join-Path $env:TEMP "luma-export-$(Get-Random)"
    try {
        New-Item -ItemType Directory -Force $stage | Out-Null
        $included = @()
        foreach ($it in $Items) {
            if (-not (Test-Path -LiteralPath $it.Path)) { continue }
            $dest = Join-Path $stage ($it.Entry -replace '/', '\')
            if (-not $DryRun) {
                New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
                Copy-Item -LiteralPath $it.Path -Destination $dest
            }
            $included += $it.Entry
            Say "  + $($it.Entry)"
        }
        if (Test-Path -LiteralPath $ProfilesDir) {
            $profBase = (Get-Item -LiteralPath $ProfilesDir).FullName.TrimEnd([char]92)
            $files = @(Get-ChildItem -LiteralPath $ProfilesDir -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -ne '.log' -and $_.Name -notlike '*.log.*' })
            Say "  + profiles\ ($($files.Count) files)"
            if (-not $DryRun) {
                foreach ($f in $files) {
                    $rel = $f.FullName.Substring($profBase.Length).TrimStart([char]92)
                    $dest = Join-Path (Join-Path $stage 'profiles') $rel
                    New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
                    Copy-Item -LiteralPath $f.FullName -Destination $dest
                }
            }
            $included += 'profiles/'
        }
        if (-not ($included | Where-Object { $_ -like 'luma-arcade.db' })) {
            Say '  (no luma-arcade.db found: has Luma Arcade been started once?)'
        }
        if ($DryRun) { Say "Dry run: would write $To"; exit 0 }
        $manifest = [ordered]@{
            format = 1; created = (Get-Date -Format s); computer = $env:COMPUTERNAME
            installDir = $InstallDir; includes = $included; databaseCopiedWhileRunning = [bool]$running
        }
        $manifest | ConvertTo-Json | Set-Content -Path (Join-Path $stage 'manifest.json') -Encoding UTF8
        New-Item -ItemType Directory -Force (Split-Path $To) | Out-Null
        $stageFull = (Get-Item -LiteralPath $stage).FullName.TrimEnd([char]92)
        $out = [IO.Compression.ZipFile]::Open($To, 'Create')
        try {
            # Entry names with forward slashes, whatever the .NET version.
            foreach ($f in Get-ChildItem -LiteralPath $stage -Recurse -File) {
                $name = $f.FullName.Substring($stageFull.Length).TrimStart([char]92).Replace([string][char]92, '/')
                [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($out, $f.FullName, $name, 'Optimal')
            }
        } finally { $out.Dispose() }
    } finally {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
    Say ''
    Say "Saved $To ($([math]::Round((Get-Item -LiteralPath $To).Length / 1MB, 1)) MB)."
    Say 'It holds your accounts and players'' saves: keep it somewhere private.'
    Say 'To restore it on a new PC: install Luma Arcade there with Setup, then run this script with -Action import -From <zip>.'
    exit 0
}

# ------------------------------------------------------------------ import
if (-not $From) { Fail 'Say which backup to restore: -From D:\arcade-backup.zip' }
$From = [IO.Path]::GetFullPath($From)
if (-not (Test-Path -LiteralPath $From)) { Fail "$From doesn't exist." }

$tmp = [IO.Path]::GetFullPath((Join-Path $env:TEMP "luma-import-$(Get-Random)"))
try {
    # Unpack to a temp folder, only the entries a backup can contain, none outside it.
    New-Item -ItemType Directory -Force $tmp | Out-Null
    $zip = [IO.Compression.ZipFile]::OpenRead($From)
    try {
        $names = @($zip.Entries | ForEach-Object { $_.FullName -replace '\\', '/' })
        if ('manifest.json' -notin $names) { Fail "$From isn't a Luma Arcade backup (no manifest.json)." }
        foreach ($e in $zip.Entries) {
            $n = $e.FullName -replace '\\', '/'
            if ($n.EndsWith('/')) { continue }
            if ($n -notmatch '^(manifest\.json|luma-arcade\.db(-wal|-shm)?|moonlight/(data|config)\.json|host\.json|profiles/.+)$' -or $n -match '(^|/)\.\.(/|$)') { continue }
            $dest = [IO.Path]::GetFullPath((Join-Path $tmp ($n -replace '/', '\')))
            if (-not $dest.StartsWith($tmp + '\', [StringComparison]::OrdinalIgnoreCase)) { continue }
            New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true)
        }
    } finally { $zip.Dispose() }
    $manifest = Get-Content -Raw (Join-Path $tmp 'manifest.json') | ConvertFrom-Json
    if ($manifest.format -ne 1) { Fail "This backup is in a format ($($manifest.format)) this script doesn't know: use a newer arcade-backup.ps1." }
    Say "Backup from $($manifest.computer), made $($manifest.created)."
    if ($manifest.databaseCopiedWhileRunning) { Say 'WARNING: this backup was made while Luma Arcade was running, so its database may be damaged.' }

    $restore = @()
    foreach ($it in $Items) {
        if ($it.Entry -eq 'host.json' -and -not $RestoreHostSettings) { continue }
        $src = Join-Path $tmp ($it.Entry -replace '/', '\')
        if (Test-Path -LiteralPath $src) { $restore += @{ Src = $src; Dest = $it.Path; Name = $it.Entry } }
    }
    $hasProfiles = Test-Path -LiteralPath (Join-Path $tmp 'profiles')
    foreach ($r in $restore) { Say "  restore $($r.Name)" }
    if ($hasProfiles) { Say '  restore profiles\' }
    if (-not $restore -and -not $hasProfiles) { Fail 'The backup has nothing to restore.' }
    if ($DryRun) { Say 'Dry run: nothing changed.'; exit 0 }

    $wasRunning = [bool](Get-LumaProcesses)
    Say 'Stopping Luma Arcade...'
    Stop-Luma

    # Keep what we're about to replace.
    $keep = Join-Path $DataDir ("import-backup-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Force $keep | Out-Null
    # It holds copies of the database and profiles: administrators and SYSTEM only.
    & icacls.exe $keep /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "Couldn't restrict access to $keep (icacls exit $LASTEXITCODE); stopping before copying anything into it." }
    foreach ($it in $Items) {
        if (Test-Path -LiteralPath $it.Path) {
            $d = Join-Path $keep ($it.Entry -replace '/', '\')
            New-Item -ItemType Directory -Force (Split-Path $d) | Out-Null
            Copy-Item -LiteralPath $it.Path -Destination $d
        }
    }
    if ($hasProfiles -and (Test-Path -LiteralPath $ProfilesDir)) { Move-Item -LiteralPath $ProfilesDir -Destination (Join-Path $keep 'profiles') }
    Say "What was replaced is kept in $keep"

    # A leftover -wal/-shm from the old database would be replayed over the restored one.
    if (Test-Path -LiteralPath (Join-Path $tmp 'luma-arcade.db')) {
        foreach ($ext in '-wal', '-shm') { Remove-Item -LiteralPath (Join-Path $DbDir "luma-arcade.db$ext") -Force -ErrorAction SilentlyContinue }
    }
    foreach ($r in $restore) {
        New-Item -ItemType Directory -Force (Split-Path $r.Dest) | Out-Null
        Copy-Item -LiteralPath $r.Src -Destination $r.Dest -Force
    }
    if ($hasProfiles) {
        New-Item -ItemType Directory -Force $DataDir | Out-Null
        Copy-Item -LiteralPath (Join-Path $tmp 'profiles') -Destination $ProfilesDir -Recurse -Force
    }
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

if (-not $NoStart) {
    & schtasks.exe /run /tn '\LumaArcade\LumaArcade' 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Say 'Started Luma Arcade.' }
    else { Say 'Start Luma Arcade from the Start menu.' }
}
Say ''
Say 'Restored. Next steps:'
Say '  1. Open http://localhost:7777 and sign in with your usual admin account.'
Say '  2. Settings > Host health: on a NEW PC, remove the old paired PC and add this one again'
Say '     (address "localhost"), then type the PIN into Sunshine (https://localhost:47990 > PIN).'
Say '  3. Internet access: Setup on this PC made its own Cloudflare tunnel; re-point your'
Say '     hostname at it (Cloudflare Zero Trust > Networks > Tunnels) if you use one.'
Say '  4. Games folders and emulators come from this PC''s Setup, not the backup. If saves look'
Say '     missing, check the games folder you chose in Setup matches the old one.'
exit 0
