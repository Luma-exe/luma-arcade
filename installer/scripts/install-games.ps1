# Downloads ES-DE (portable) and/or emulators from their official releases
# into one games folder. Run by the installer (LumaArcade.nsi); can also be
# run by hand to add or update emulators:
#   powershell -ExecutionPolicy Bypass -File install-games.ps1 -GamesDir C:\Games -WithEsDe -Emulators retroarch,dolphin
# -ListOnly prints what would be downloaded (and checks every source) without
# downloading anything.
param(
    [Parameter(Mandatory)] [string]$GamesDir,
    [switch]$WithEsDe,
    [string]$Emulators = '',
    [switch]$ListOnly
)
. (Join-Path $PSScriptRoot 'common.ps1')

# With ES-DE, emulators go in ES-DE\Emulators\<Folder>: the folder names ES-DE's
# portable find rules look for, so every system works without setting paths.
# Portable = marker files/folders that keep an emulator's settings and saves
# in its own folder (shared by every account) instead of the user profile.
$Catalog = [ordered]@{
    retroarch   = @{ Name = 'RetroArch (NES, SNES, Mega Drive, Game Boy, N64, PC Engine, arcade...)'; Folder = 'RetroArch-Win64'; Exe = 'retroarch.exe'
                     Source = { $tag = (Get-LatestRelease 'libretro/RetroArch').tag_name.TrimStart('v')
                                @{ Url = "https://buildbot.libretro.com/stable/$tag/windows/x86_64/RetroArch.7z"; Name = 'RetroArch.7z'; Version = $tag } } }
    dolphin     = @{ Name = 'Dolphin (GameCube, Wii)'; Folder = 'Dolphin-x64'; Exe = 'Dolphin.exe'; Portable = @('portable.txt')
                     Source = { $tags = Invoke-RestMethod 'https://api.github.com/repos/dolphin-emu/dolphin/tags?per_page=30' -Headers $script:UserAgent
                                $tag = ($tags | Where-Object { $_.name -match '^\d{4}$' } | Sort-Object { [int]$_.name } -Descending | Select-Object -First 1).name
                                @{ Url = "https://dl.dolphin-emu.org/releases/$tag/dolphin-$tag-x64.7z"; Name = "dolphin-$tag-x64.7z"; Version = $tag } } }
    pcsx2       = @{ Name = 'PCSX2 (PlayStation 2)'; Folder = 'PCSX2-Qt'; Exe = 'pcsx2-qt.exe'; Portable = @('portable.ini'); Repo = 'PCSX2/pcsx2'; Pattern = '-windows-x64-Qt\.7z$' }
    duckstation = @{ Name = 'DuckStation (PlayStation)'; Folder = 'duckstation'; Exe = 'duckstation-qt-x64-ReleaseLTCG.exe'; Portable = @('portable.txt'); Repo = 'stenzek/duckstation'; Pattern = '^duckstation-windows-x64-release\.zip$' }
    ppsspp      = @{ Name = 'PPSSPP (PSP)'; Folder = 'PPSSPP'; Exe = 'PPSSPPWindows64.exe'; Repo = 'hrydgard/ppsspp'; Pattern = 'Windows-x64\.zip$' }
    rpcs3       = @{ Name = 'RPCS3 (PlayStation 3)'; Folder = 'RPCS3'; Exe = 'rpcs3.exe'; Repo = 'RPCS3/rpcs3-binaries-win'; Pattern = '_win64.*\.7z$' }
    xenia       = @{ Name = 'Xenia Canary (Xbox 360)'; Folder = 'xenia_canary'; Exe = 'xenia_canary.exe'; Portable = @('portable.txt'); Repo = 'xenia-canary/xenia-canary-releases'; Pattern = 'windows.*\.zip$' }
    xemu        = @{ Name = 'xemu (original Xbox)'; Folder = 'xemu'; Exe = 'xemu.exe'; Repo = 'xemu-project/xemu'; Pattern = '^xemu-[\d.]+-windows-x86_64\.zip$' }
    cemu        = @{ Name = 'Cemu (Wii U)'; Folder = 'cemu'; Exe = 'Cemu.exe'; PortableDirs = @('portable'); Repo = 'cemu-project/Cemu'; Pattern = 'windows-x64\.zip$' }
    azahar      = @{ Name = 'Azahar (Nintendo 3DS)'; Folder = 'azahar'; Exe = 'azahar.exe'; PortableDirs = @('user'); Repo = 'azahar-emu/azahar'; Pattern = '^azahar-windows-msvc-[\d.]+\.zip$' }
    melonds     = @{ Name = 'melonDS (Nintendo DS)'; Folder = 'melonDS'; Exe = 'melonDS.exe'; Repo = 'melonDS-emu/melonDS'; Pattern = 'windows-x86_64\.zip$' }
    vita3k      = @{ Name = 'Vita3K (PS Vita)'; Folder = 'Vita3K'; Exe = 'Vita3K.exe'; Repo = 'Vita3K/Vita3K'; Pattern = '^windows-latest\.zip$' }
    shadps4     = @{ Name = 'shadPS4 (PlayStation 4, experimental)'; Folder = 'shadPS4'; Exe = 'shadPS4.exe'; Repo = 'shadps4-emu/shadPS4'; Pattern = 'win64.*\.zip$' }
    flycast     = @{ Name = 'Flycast (Dreamcast, Naomi)'; Folder = 'flycast'; Exe = 'flycast.exe'; Repo = 'flyinghead/flycast'; Pattern = 'win64.*\.zip$' }
}

# RetroArch cores for ES-DE's default emulator on each classic system.
$RetroArchCores = @('mesen', 'snes9x', 'genesis_plus_gx', 'picodrive', 'mgba', 'gambatte', 'mupen64plus_next', 'mednafen_pce', 'fbneo', 'stella')

function Resolve-Source($entry) {
    if ($entry.Source) { return [pscustomobject](& $entry.Source) }
    Get-GitHubAsset $entry.Repo $entry.Pattern
}

$wanted = @($Emulators -split '[,\s]+' | Where-Object { $_ } | ForEach-Object { $_.ToLowerInvariant() })
if ($wanted -contains 'all') { $wanted = @($Catalog.Keys) }
$unknown = @($wanted | Where-Object { -not $Catalog.Contains($_) })
if ($unknown) { throw "Unknown emulator(s): $($unknown -join ', '). Known: $($Catalog.Keys -join ', ')" }

$esdeDir = Join-Path $GamesDir 'ES-DE'
$emuRoot = if ($WithEsDe) { Join-Path $esdeDir 'Emulators' } else { Join-Path $GamesDir 'Emulators' }
$failed = @()
$installed = @()

if (-not $ListOnly) { New-Item -ItemType Directory -Force $GamesDir | Out-Null }

if ($WithEsDe) {
    Write-Step 'ES-DE (the game library you browse with a controller)'
    try {
        $release = (Invoke-RestMethod 'https://gitlab.com/api/v4/projects/es-de%2Femulationstation-de/releases?per_page=1' -Headers $script:UserAgent)[0]
        $link = $release.assets.links | Where-Object { $_.name -match 'x64_Portable\.zip$' } | Select-Object -First 1
        if (-not $link) { throw "No Windows portable download in ES-DE $($release.tag_name)" }
        Write-Note "$($link.name)"
        if (-not $ListOnly) {
            Expand-Download (Save-Download $link.url 'ES-DE-portable.zip') $esdeDir
            $installed += "ES-DE $($release.tag_name)"
        }
    } catch {
        Write-Note "FAILED: $($_.Exception.Message)"
        $failed += 'ES-DE'
    }
}

foreach ($key in $wanted) {
    $entry = $Catalog[$key]
    Write-Step $entry.Name
    try {
        $src = Resolve-Source $entry
        Write-Note "$($src.Name) ($($src.Version))"
        if ($ListOnly) { continue }
        $dir = Join-Path $emuRoot $entry.Folder
        Expand-Download (Save-Download $src.Url $src.Name) $dir
        foreach ($f in @($entry.Portable)) { if ($f) { New-Item -ItemType File -Force (Join-Path $dir $f) | Out-Null } }
        foreach ($d in @($entry.PortableDirs)) { if ($d) { New-Item -ItemType Directory -Force (Join-Path $dir $d) | Out-Null } }
        if ($key -eq 'retroarch') {
            $cores = Join-Path $dir 'cores'
            New-Item -ItemType Directory -Force $cores | Out-Null
            foreach ($core in $RetroArchCores) {
                try {
                    $zip = Save-Download "https://buildbot.libretro.com/nightly/windows/x86_64/latest/${core}_libretro.dll.zip" "${core}_libretro.dll.zip"
                    Expand-Archive -LiteralPath $zip -DestinationPath $cores -Force
                    Remove-Item -Force $zip
                } catch { Write-Note "core $core FAILED: $($_.Exception.Message)" }
            }
            Write-Note "cores: $($RetroArchCores -join ', ')"
        }
        $installed += "$($entry.Name) $($src.Version)"
    } catch {
        Write-Note "FAILED: $($_.Exception.Message)"
        $failed += $entry.Name
    }
}

if ($ListOnly) {
    if ($failed) { Write-Output "Could not resolve: $($failed -join '; ')"; exit 1 }
    exit 0
}

# Shortcuts for everyone: ES-DE on the desktop, or (without ES-DE, nothing
# else would list them) each emulator in the Start menu.
$shell = New-Object -ComObject WScript.Shell
function New-Shortcut([string]$Link, [string]$Target) {
    if (-not (Test-Path $Target)) { return }
    New-Item -ItemType Directory -Force (Split-Path $Link) | Out-Null
    $s = $shell.CreateShortcut($Link)
    $s.TargetPath = $Target
    $s.WorkingDirectory = Split-Path $Target
    $s.Save()
}
if ($WithEsDe) {
    New-Shortcut (Join-Path $env:PUBLIC 'Desktop\ES-DE.lnk') (Join-Path $esdeDir 'ES-DE.exe')
} else {
    $menu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Emulators'
    foreach ($key in $wanted) {
        $entry = $Catalog[$key]
        $exe = Get-ChildItem -Path (Join-Path $emuRoot $entry.Folder) -Filter $entry.Exe -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($exe) { New-Shortcut (Join-Path $menu (($entry.Name -replace ' \(.*$', '') + '.lnk')) $exe.FullName }
    }
}

# This script stays with the games, for adding or updating emulators later.
$setupDir = Join-Path $GamesDir 'setup'
New-Item -ItemType Directory -Force $setupDir | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'common.ps1'), (Join-Path $PSScriptRoot 'install-games.ps1') $setupDir -Force

Write-Step 'Letting every account on this PC use the games folder'
Grant-UsersModify $GamesDir

$readme = Join-Path $GamesDir 'READ ME - games setup.txt'
@"
Set up by the Luma Arcade installer on $(Get-Date -Format 'yyyy-MM-dd').

Installed:
$(($installed | ForEach-Object { "  - $_" }) -join "`r`n")
$(if ($failed) { "`r`nCould not install (try again later, or download by hand):`r`n" + (($failed | ForEach-Object { "  - $_" }) -join "`r`n") })

Emulators: $emuRoot
$(if ($WithEsDe) { "ES-DE:     $esdeDir\ES-DE.exe  (shortcut on the desktop)
Games:     put them in $esdeDir\ROMs\<system>\ - ES-DE offers to create
           these folders the first time it starts (e.g. ROMs\snes, ROMs\ps2)." })

BIOS and firmware are NOT included - dump them from consoles you own:
  - RetroArch (PS1, PC Engine CD, ...): $emuRoot\RetroArch-Win64\system\
  - PCSX2 (PS2):   $emuRoot\PCSX2-Qt\bios\
  - DuckStation:   $emuRoot\duckstation\bios\
  - RPCS3 (PS3):   in RPCS3: File > Install Firmware (PS3UPDAT.PUP)
  - Vita3K:        in Vita3K: install the firmware (PSVUPDAT.PUP)
  - xemu (Xbox):   point xemu at your BIOS/MCPX/HDD image in its settings

To add or update emulators later, run as administrator:
  powershell -ExecutionPolicy Bypass -File "$GamesDir\setup\install-games.ps1" -GamesDir "$GamesDir"$(if ($WithEsDe) { ' -WithEsDe' }) -Emulators <names>
  Names: $($Catalog.Keys -join ', ')
"@ | Set-Content -Path $readme -Encoding UTF8

if ($failed) {
    Write-Step "Done, but these failed: $($failed -join '; ') (see $readme)"
} else {
    Write-Step "Done. See $readme"
}
