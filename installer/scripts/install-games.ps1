# Downloads ES-DE (portable) and/or emulators from their official releases
# into one games folder. Run by the installer (LumaArcade.nsi); can also be
# run by hand to add or update emulators:
#   powershell -ExecutionPolicy Bypass -File install-games.ps1 -GamesDir C:\Games -WithEsDe -Emulators retroarch,dolphin
# -ListOnly prints what would be downloaded (and checks every source) without
# downloading anything. Downloads are the tested versions in versions.json
# (checksums checked); -Latest takes each one's newest release instead.
param(
    [Parameter(Mandatory)] [string]$GamesDir,
    [switch]$WithEsDe,
    [string]$Emulators = '',
    [switch]$ListOnly,
    [switch]$Latest
)
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'catalog.ps1')

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
        $src = Get-CatalogDownload 'esde' -Latest:$Latest
        Write-Note "$($src.Name) ($($src.Version)$(if (-not $src.Pinned) { ', newest' }))"
        if (-not $ListOnly) {
            Expand-Download (Save-CatalogDownload 'esde' $src) $esdeDir
            $installed += "ES-DE $($src.Version)"
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
        $src = Get-CatalogDownload $key -Latest:$Latest
        Write-Note "$($src.Name) ($($src.Version)$(if (-not $src.Pinned) { ', newest' }))"
        if ($ListOnly) { continue }
        $dir = Join-Path $emuRoot $entry.Folder
        Expand-Download (Save-CatalogDownload $key $src) $dir
        foreach ($f in @($entry.Portable)) { if ($f) { New-Item -ItemType File -Force (Join-Path $dir $f) | Out-Null } }
        foreach ($d in @($entry.PortableDirs)) { if ($d) { New-Item -ItemType Directory -Force (Join-Path $dir $d) | Out-Null } }
        if ($key -eq 'retroarch') {
            try {
                # Only the cores ES-DE uses, out of the stable bundle for this version.
                $bundle = Get-CatalogDownload 'retroarch-cores' -Latest:$Latest
                $file = Save-CatalogDownload 'retroarch-cores' $bundle
                $cores = Join-Path $dir 'cores'
                New-Item -ItemType Directory -Force $cores | Out-Null
                $names = @($RetroArchCores | ForEach-Object { "$($_)_libretro.dll" })
                & (Get-SevenZip) e $file "-o$cores" -y -r @names | Out-Null
                if ($LASTEXITCODE) { throw "7-Zip couldn't unpack the cores" }
                Remove-Item -Force $file
                $missing = @($names | Where-Object { -not (Test-Path (Join-Path $cores $_)) })
                if ($missing) { Write-Note "cores not in the bundle: $($missing -join ', ')" }
                Write-Note "cores ($($bundle.Version)): $($RetroArchCores -join ', ')"
            } catch { Write-Note "cores FAILED: $($_.Exception.Message)" }
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
Copy-Item (Join-Path $PSScriptRoot 'common.ps1'), (Join-Path $PSScriptRoot 'catalog.ps1'), (Join-Path $PSScriptRoot 'install-games.ps1') $setupDir -Force
if (Test-Path $script:VersionsFile) { Copy-Item $script:VersionsFile $setupDir -Force }

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
  (add -Latest for each one's newest release instead of the tested version)
"@ | Set-Content -Path $readme -Encoding UTF8

if ($failed) {
    Write-Step "Done, but these failed: $($failed -join '; ') (see $readme)"
} else {
    Write-Step "Done. See $readme"
}
