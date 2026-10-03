# Removes what Setup installed besides Luma Arcade itself, for the
# uninstaller's "what to remove" list (runs elevated). Each part is only
# touched when asked for:
#  -Sunshine        Sunshine, with its settings, sign-in, paired devices
#                   and app pictures (C:\Program Files\Sunshine)
#  -EsDe            ES-DE in the games folder, its desktop shortcut and its
#                   settings and game lists in each account (ROMs and
#                   Emulators inside it stay unless asked for)
#  -Emulators       emulator keys (catalog.ps1), each with its settings and
#                   any saves kept in its own folder
#  -VirtualDisplay  the Virtual Display Driver and C:\VirtualDisplayDriver
#  -ViGEm           ViGEmBus, the virtual controller driver
#  -Games           the whole games folder: ROMs, saves, BIOS, ES-DE and
#                   emulators - and C:\ProgramData\LumaArcade (whose saves
#                   are where)
#  -GamesDir        the games folder Setup used
#  -TestRoot        testing: Sunshine and ProgramData under this folder, and
#                   no services, drivers or uninstallers run
param(
    [string]$GamesDir = '',
    [switch]$Sunshine,
    [switch]$EsDe,
    [string]$Emulators = '',
    [switch]$VirtualDisplay,
    [switch]$ViGEm,
    [switch]$Games,
    [string]$TestRoot = ''
)
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'catalog.ps1')
$ErrorActionPreference = 'Continue'

$sunshineDir = Join-Path $env:ProgramFiles 'Sunshine'
$dataDir = 'C:\ProgramData\LumaArcade'
$profilesRoot = Split-Path $env:PUBLIC
if ($TestRoot) {
    $sunshineDir = Join-Path $TestRoot 'Sunshine'
    $dataDir = Join-Path $TestRoot 'LumaArcade'
    $profilesRoot = Join-Path $TestRoot 'Users'
}
$sunshineApps = Join-Path $sunshineDir 'config\apps.json'
$esdeDir = if ($GamesDir) { Join-Path $GamesDir 'ES-DE' } else { '' }
$failed = $false

function Remove-Folder([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return }
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $Path) {
        Write-Note "couldn't delete all of $Path (something has it open): delete it after a restart"
        $script:failed = $true
    }
}

# The uninstaller Windows lists for a program, newest first.
function Get-UninstallEntry([string]$NamePattern) {
    $keys = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    Get-ItemProperty $keys -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like $NamePattern -and $_.UninstallString } |
        Sort-Object { $_.DisplayVersion } -Descending
}

# Runs a program's own uninstaller with no windows: an MSI by its product
# code, anything else with the quiet switches given.
function Invoke-Uninstaller($Entry, [string[]]$QuietArgs) {
    if ($Entry.UninstallString -match '\{[0-9A-Fa-f-]{36}\}' -and $Entry.UninstallString -match 'msiexec') {
        $p = Start-Process msiexec.exe -ArgumentList '/x', $Matches[0], '/qn', '/norestart' -Wait -PassThru
    } else {
        $cmd = if ($Entry.QuietUninstallString) { $Entry.QuietUninstallString } else { $Entry.UninstallString }
        if ($cmd -match '^\s*"([^"]+)"\s*(.*)$') { $exe = $Matches[1]; $rest = $Matches[2] }
        else { $exe = ($cmd -split '\s+', 2)[0]; $rest = ($cmd -split '\s+', 2)[1] }
        $argList = @($rest) + $(if (-not $Entry.QuietUninstallString) { $QuietArgs }) | Where-Object { $_ }
        $p = Start-Process -FilePath $exe -ArgumentList $argList -Wait -PassThru
    }
    # 3010 = done, restart needed; 1605 = already gone.
    if ($p.ExitCode -notin 0, 1605, 3010) { throw "its uninstaller failed (exit code $($p.ExitCode))" }
    if ($p.ExitCode -eq 3010) { Write-Note 'Windows needs a restart to finish' }
}

# Driver packages (oemNN.inf) whose original .inf is this one.
function Get-DriverPackages([string]$InfName) {
    $published = $null
    foreach ($line in (& "$env:SystemRoot\System32\pnputil.exe" /enum-drivers)) {
        if ($line -match ':\s*(oem\d+\.inf)\s*$') { $published = $Matches[1] }
        elseif ($line -match ':\s*(\S+\.inf)\s*$' -and $published -and $Matches[1] -ieq $InfName) { $published; $published = $null }
    }
}

# --- emulators (before ES-DE: they can live inside its folder)

$wanted = @($Emulators -split '[,\s]+' | Where-Object { $_ } | ForEach-Object { $_.ToLowerInvariant() })
foreach ($key in $wanted) {
    if (-not $Catalog.Contains($key)) { Write-Note "unknown emulator '$key': skipped"; continue }
    $entry = $Catalog[$key]
    $short = $entry.Name -replace ' \(.*$', ''
    Write-Step "Removing $short"
    if ($GamesDir) {
        Remove-Folder (Join-Path $esdeDir "Emulators\$($entry.Folder)")
        Remove-Folder (Join-Path $GamesDir "Emulators\$($entry.Folder)")
    }
    $menu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Emulators'
    if (-not $TestRoot) { Remove-Item -Force (Join-Path $menu "$short.lnk") -ErrorAction SilentlyContinue }
}
foreach ($dir in @($(if ($GamesDir) { (Join-Path $esdeDir 'Emulators'), (Join-Path $GamesDir 'Emulators') }))) {
    if ((Test-Path $dir) -and -not (Get-ChildItem $dir -Force -ErrorAction SilentlyContinue)) { Remove-Item $dir -Force }
}
if (-not $TestRoot) {
    $menu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Emulators'
    if ((Test-Path $menu) -and -not (Get-ChildItem $menu -Force)) { Remove-Item $menu -Force }
}

# --- ES-DE

if ($EsDe) {
    Write-Step 'Removing ES-DE (your ROMs folder stays)'
    if ($esdeDir -and (Test-Path $esdeDir)) {
        $keep = @('ROMs', 'Emulators')
        Get-ChildItem -LiteralPath $esdeDir -Force | Where-Object { $_.Name -notin $keep } | ForEach-Object { Remove-Folder $_.FullName }
        if (-not (Get-ChildItem -LiteralPath $esdeDir -Force -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath $esdeDir -Force }
        else { Write-Note "kept $esdeDir\ROMs and any emulators still inside it" }
    }
    if (-not $TestRoot) { Remove-Item -Force (Join-Path $env:PUBLIC 'Desktop\ES-DE.lnk') -ErrorAction SilentlyContinue }
    # Each account's ES-DE folder: settings, game lists, favorites, the
    # event scripts and any scraped pictures.
    Get-ChildItem $profilesRoot -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
        $mine = Join-Path $_.FullName 'ES-DE'
        if (Test-Path (Join-Path $mine 'settings\es_settings.xml')) { Write-Note "its settings in $mine"; Remove-Folder $mine }
    }
    # Sunshine (when it stays) no longer lists it.
    if (-not $Sunshine -and (Test-Path $sunshineApps)) {
        $apps = Get-Content -Raw $sunshineApps | ConvertFrom-Json
        $left = @($apps.apps | Where-Object { $_.name -ne 'ES-DE' })
        if ($left.Count -ne @($apps.apps).Count) {
            Write-Note "taken off Sunshine's apps"
            $apps.apps = $left
            Copy-Item $sunshineApps "$sunshineApps.bak-luma-uninstall" -Force
            $apps | ConvertTo-Json -Depth 10 | Set-Content -Path $sunshineApps -Encoding UTF8
            if (-not $TestRoot) { Restart-Service SunshineService -Force -ErrorAction SilentlyContinue }
        }
    }
}

# --- Sunshine

if ($Sunshine) {
    Write-Step 'Removing Sunshine, with its settings and paired devices'
    try {
        if (-not $TestRoot) {
            Stop-Service SunshineService -Force -ErrorAction SilentlyContinue
            $entry = Get-UninstallEntry 'Sunshine*' | Select-Object -First 1
            if ($entry) { Invoke-Uninstaller $entry @('/S') } else { Write-Note "Windows doesn't list its uninstaller: deleting its folder" }
        }
        Remove-Folder $sunshineDir
    } catch {
        Write-Note "FAILED: $($_.Exception.Message). Remove it in Settings > Apps."
        $failed = $true
    }
}

# --- drivers

if ($VirtualDisplay) {
    Write-Step 'Removing the Virtual Display Driver'
    if (-not $TestRoot) {
        try {
            $devices = @(Get-CimInstance Win32_PnPEntity -Filter "PNPDeviceID LIKE 'ROOT\\DISPLAY\\%'" | Where-Object { $_.HardwareID -contains 'Root\MttVDD' })
            foreach ($d in $devices) {
                & "$env:SystemRoot\System32\pnputil.exe" /remove-device $d.PNPDeviceID | Out-Null
                if ($LASTEXITCODE -notin 0, 3010) { throw "pnputil couldn't remove the device (exit code $LASTEXITCODE)" }
            }
            foreach ($inf in @(Get-DriverPackages 'MttVDD.inf')) {
                & "$env:SystemRoot\System32\pnputil.exe" /delete-driver $inf /uninstall /force | Out-Null
            }
        } catch {
            Write-Note "FAILED: $($_.Exception.Message). Remove it in Device Manager > Display adapters."
            $failed = $true
        }
    }
    Remove-Folder $(if ($TestRoot) { Join-Path $TestRoot 'VirtualDisplayDriver' } else { 'C:\VirtualDisplayDriver' })
}

if ($ViGEm -and -not $TestRoot) {
    Write-Step 'Removing ViGEmBus (virtual controllers)'
    try {
        $entry = Get-UninstallEntry 'ViGEm Bus Driver*' | Select-Object -First 1
        if ($entry) { Invoke-Uninstaller $entry @('/qn', '/norestart') }
        else { Write-Note "Windows doesn't list it: nothing to remove" }
    } catch {
        Write-Note "FAILED: $($_.Exception.Message). Remove ""ViGEm Bus Driver"" in Settings > Apps."
        $failed = $true
    }
}

# --- the games folder, last (everything above may live in it)

if ($Games) {
    if ($GamesDir -and (Test-Path -LiteralPath $GamesDir)) {
        Write-Step "Deleting the games folder $GamesDir (games, saves, BIOS, ES-DE and emulators)"
        Remove-Folder $GamesDir
    }
    Write-Step "Deleting $dataDir (which player's saves are where)"
    Remove-Folder $dataDir
}

if ($failed) { exit 1 }
Write-Step 'Done'
