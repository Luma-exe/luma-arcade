# The PC-side half of Luma Arcade (runs elevated). The website asks these
# scripts to act on the games desktop, which it can't do itself:
#   home.ps1            the stream page's Home button and window picker
#   lockdown.ps1        closes admin tools while a guest is playing
#   stream-start.ps1    Sunshine's prep-cmd: per-player saves (profiles.ps1)
#                       and bringing ES-DE / Big Picture to the front
#                       (focus-app.ps1)
#   esde-game-*.ps1     ES-DE event scripts: what's being played (game
#                       tracking) and minimizing ES-DE behind a game (it
#                       otherwise steals a held stick direction)
#   emulator-window.ps1 ES-DE event script: Switch, Wii and GameCube games
#                       fill the screen whatever size the previous player
#                       streamed at
#   esde-keepalive.ps1  what Sunshine's ES-DE app runs: starts ES-DE again
#                       when a player quits it from its menu
# They go in C:\ProgramData\LumaArcade (the website looks for them there),
# with host.json saying where ES-DE, the emulators and the saves are.
#  -LumaDir   Luma Arcade's install folder (the scripts are in its host\)
#  -Account   the Windows account the games run under
#  -Port      Luma Arcade's port (Sunshine's prep-cmd asks it who's playing)
#  -GamesDir  the games folder (save snapshots go in it)
#  -EsDeExe   ES-DE.exe (default: Sunshine's ES-DE app)
#  -TestRoot  testing: ProgramData and Sunshine's apps.json under this
#             folder instead, and no scheduled tasks
param(
    [Parameter(Mandatory)] [string]$LumaDir,
    [string]$Account = '',
    [int]$Port = 7777,
    [string]$GamesDir = '',
    [string]$EsDeExe = '',
    [string]$TestRoot = ''
)
. (Join-Path $PSScriptRoot 'common.ps1')

if (-not $Account) { $Account = $env:USERNAME }
# The website has this folder written in (web/routes/home.ts and others).
$dataDir = 'C:\ProgramData\LumaArcade'
$source = Join-Path $LumaDir 'host'
$sunshineApps = Join-Path $env:ProgramFiles 'Sunshine\config\apps.json'
if ($TestRoot) { $dataDir = Join-Path $TestRoot 'LumaArcade'; $sunshineApps = Join-Path $TestRoot 'apps.json' }

Write-Step "Luma Arcade's helper scripts ($dataDir)"
foreach ($dir in $dataDir, "$dataDir\home", "$dataDir\profiles") { New-Item -ItemType Directory -Force $dir | Out-Null }
Get-ChildItem $source -Filter *.ps1 | Where-Object { $_.Name -notlike '*.tests.ps1' } | Copy-Item -Destination $dataDir -Force
# The account writes requests, results, logs and save state here.
foreach ($dir in "$dataDir\home", "$dataDir\profiles") {
    & icacls.exe $dir /grant "${Account}:(OI)(CI)M" /T /C /Q | Out-Null
}

# Where things are. ES-DE: the one given, else the one Sunshine starts.
if (-not $EsDeExe -and (Test-Path $sunshineApps)) {
    $app = (Get-Content -Raw $sunshineApps | ConvertFrom-Json).apps | Where-Object { $_.name -eq 'ES-DE' } | Select-Object -First 1
    # Set up before: Sunshine starts esde-keepalive.ps1 -Exe "<ES-DE.exe>".
    if ($app -and $app.cmd -match 'esde-keepalive\.ps1.*-Exe\s+"([^"]+)"') { $EsDeExe = $Matches[1] }
    elseif ($app -and $app.cmd) { $EsDeExe = $app.cmd.Trim('"') }
}
$esDeDir = if ($EsDeExe) { Split-Path $EsDeExe } else { '' }
$profileDir = $null
try {
    $sid = (New-Object Security.Principal.NTAccount($Account)).Translate([Security.Principal.SecurityIdentifier]).Value
    $profileDir = (Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid }).LocalPath
} catch { }
# A new account has no profile until it first signs in; Windows will make this one.
if (-not $profileDir) { $profileDir = Join-Path "$env:SystemDrive\Users" $Account }
# The portable ES-DE keeps its settings in ES-DE\ES-DE, the installed one in the profile.
$esDeData = if (-not $esDeDir) { '' } elseif (Test-Path (Join-Path $esDeDir 'portable.txt')) { Join-Path $esDeDir 'ES-DE' } else { Join-Path $profileDir 'ES-DE' }
$emulators = if ($esDeDir) { Join-Path $esDeDir 'Emulators' } elseif ($GamesDir) { Join-Path $GamesDir 'Emulators' } else { '' }
$snapshots = if ($GamesDir) { Join-Path $GamesDir 'Save snapshots' } else { Join-Path $dataDir 'snapshots' }
New-Item -ItemType Directory -Force $snapshots | Out-Null
& icacls.exe $snapshots /grant "${Account}:(OI)(CI)M" /T /C /Q | Out-Null

$config = [ordered]@{
    account   = $Account
    port      = $Port
    esDe      = $EsDeExe
    esDeDir   = $esDeDir
    gamelists = $(if ($esDeData) { Join-Path $esDeData 'gamelists' } else { '' })
    emulators = $emulators
    roaming   = (Join-Path $profileDir 'AppData\Roaming')
    snapshots = $snapshots
}
$config | ConvertTo-Json | Set-Content -Path "$dataDir\host.json" -Encoding UTF8
Write-Note "ES-DE: $(if ($EsDeExe) { $EsDeExe } else { 'not found - the Home button can only switch to it while it runs' })"

# Scheduled tasks that run the helpers on the games desktop, as the account
# (the website may run in the background, where it can't reach that desktop).
Write-Step "Scheduled tasks \LumaArcade\Home and \LumaArcade\Lockdown (run as $Account)"
$sidAccount = (New-Object Security.Principal.NTAccount($Account)).Translate([Security.Principal.SecurityIdentifier]).Value
$principal = New-ScheduledTaskPrincipal -UserId $sidAccount -LogonType Interactive -RunLevel Highest
$tasks = @(
    @{ Name = 'Home'; Script = 'home.ps1'; Limit = [TimeSpan]::FromMinutes(2); Instances = 'Parallel' },
    @{ Name = 'Lockdown'; Script = 'lockdown.ps1'; Limit = [TimeSpan]::Zero; Instances = 'IgnoreNew' }
)
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
foreach ($t in $tasks) {
    if ($TestRoot) { continue }
    # conhost --headless: no console window flashing up in front of the game.
    $action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $dataDir\$($t.Script)"
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit $t.Limit -MultipleInstances $t.Instances
    Register-ScheduledTask -TaskName $t.Name -TaskPath '\LumaArcade\' -Action $action -Principal $principal -Settings $settings -Force | Out-Null
    # The website starts these with schtasks /run; when it runs as the
    # account itself, the account needs to be allowed to run them.
    $scheduler.GetFolder('\LumaArcade').GetTask($t.Name).SetSecurityDescriptor("D:(A;;FA;;;BA)(A;;FA;;;SY)(A;;FRFX;;;$sidAccount)", 0)
}

# ES-DE: the event scripts, and the two settings they rely on.
if ($esDeData) {
    Write-Step "ES-DE: game tracking and keeping it out of the way during games ($esDeData)"
    if (Get-Process ES-DE -ErrorAction SilentlyContinue) {
        Write-Note 'ES-DE is open: close it and run Setup again, or it will undo its settings change when it closes'
    }
    $events = Join-Path $esDeData 'scripts\game-start'
    New-Item -ItemType Directory -Force $events | Out-Null
    @(
        '@echo off'
        "rem Minimizes ES-DE once the game is in front, see $dataDir\esde-game-started.ps1"
        "start `"`" /b powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$dataDir\esde-game-started.ps1`""
    ) | Set-Content -Path (Join-Path $events '01-minimize-es-de.bat') -Encoding ASCII
    @(
        '@echo off'
        "rem Tells Luma Arcade which game is being played, see $dataDir\esde-game-events.ps1"
        'rem ES-DE passes: ROM path, game name, system name, system full name (quoted).'
        "start `"`" /b powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$dataDir\esde-game-events.ps1`" -Rom %1 -Name %2 -System %3"
    ) | Set-Content -Path (Join-Path $events '02-luma-game-events.bat') -Encoding ASCII
    @(
        '@echo off'
        "rem Switch, Wii and GameCube games fill the screen whatever size the last player streamed at, see $dataDir\emulator-window.ps1"
        'rem Runs without "start" so the saved window size is gone before the emulator starts.'
        'for %%s in (switch wii gc gamecube wiiware) do if /i "%~3"=="%%s" goto run'
        'exit /b 0'
        ':run'
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$dataDir\emulator-window.ps1`" -System %3"
    ) | Set-Content -Path (Join-Path $events '00-emulator-window.bat') -Encoding ASCII

    # CustomEventScripts: run the scripts above. RunInBackground: keep ES-DE
    # responsive while a game runs, so the Home button can switch back to it.
    $settingsFile = Join-Path $esDeData 'settings\es_settings.xml'
    New-Item -ItemType Directory -Force (Split-Path $settingsFile) | Out-Null
    $lines = @(if (Test-Path $settingsFile) { Get-Content $settingsFile } else { '<?xml version="1.0"?>' })
    foreach ($name in 'CustomEventScripts', 'RunInBackground') {
        $line = "<bool name=`"$name`" value=`"true`" />"
        $at = @(for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match "name=`"$name`"") { $i } })
        if ($at) { $lines[$at[0]] = $line } else { $lines += $line }
    }
    $lines | Set-Content -Path $settingsFile -Encoding UTF8
    # ES-DE runs as the account, which must be able to write all of it.
    & icacls.exe $esDeData /grant "${Account}:(OI)(CI)M" /T /C /Q | Out-Null
}

# Sunshine runs stream-start.ps1 before starting ES-DE or Big Picture.
if (Test-Path $sunshineApps) {
    $apps = Get-Content -Raw $sunshineApps | ConvertFrom-Json
    $changed = $false
    $start = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $dataDir\stream-start.ps1"
    $wanted = @{ 'ES-DE' = "$start -Port $Port -FocusProcess ES-DE"; 'Steam Big Picture' = "$start -FocusTitle `"*Big Picture*`"" }
    foreach ($app in $apps.apps) {
        # ES-DE starts through esde-keepalive.ps1, which starts it again if a
        # player picks "Quit ES-DE" (they'd be left on the desktop).
        if ($app.name -eq 'ES-DE' -and $EsDeExe -and $app.cmd -notmatch 'esde-keepalive\.ps1') {
            Write-Step 'Sunshine: ES-DE starts again if a player quits it'
            $app.cmd = "conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File $dataDir\esde-keepalive.ps1 -Exe `"$EsDeExe`""
            $changed = $true
        }
        if (-not $wanted.ContainsKey($app.name)) { continue }
        $prep = @($app.'prep-cmd' | Where-Object { $_ })
        # Already set up (by Setup, or by hand with the older profiles.ps1).
        if ($prep | Where-Object { $_.do -match 'stream-start\.ps1|profiles\.ps1' }) {
            $fixed = $false
            foreach ($p in $prep) {
                if ($p.do -match 'stream-start\.ps1' -and $p.do -match '-Port \d+' -and $p.do -notmatch "-Port $Port\b") {
                    $p.do = $p.do -replace '-Port \d+', "-Port $Port"; $fixed = $true
                }
            }
            if ($fixed) { $changed = $true; Write-Note "$($app.name): port changed to $Port" }
            continue
        }
        Write-Step "Sunshine: $($app.name) starts with Luma Arcade's stream-start.ps1"
        # Sunshine's own Big Picture entry has an empty "do" with an "undo".
        $empty = $prep | Where-Object { -not $_.do } | Select-Object -First 1
        if ($empty) { $empty.do = $wanted[$app.name] }
        else { $prep = @([pscustomobject]@{ do = $wanted[$app.name]; undo = '' }) + $prep }
        $app | Add-Member -NotePropertyName 'prep-cmd' -NotePropertyValue $prep -Force
        $changed = $true
    }
    if ($changed) {
        Copy-Item $sunshineApps "$sunshineApps.bak-luma-setup" -Force
        $apps | ConvertTo-Json -Depth 10 | Set-Content -Path $sunshineApps -Encoding UTF8
        # Sunshine only rereads apps.json when its service restarts.
        if (-not $TestRoot) { Restart-Service SunshineService -Force -ErrorAction SilentlyContinue }
    }
}

Write-Step 'Helper scripts done'
