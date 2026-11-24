# Downloads ES-DE (portable) and/or emulators from their official releases
# into one games folder. Run by the installer (LumaArcade.nsi); can also be
# run by hand to add or update emulators:
#   powershell -ExecutionPolicy Bypass -File install-games.ps1 -GamesDir C:\Games -WithEsDe -Emulators retroarch,dolphin
# -ListOnly prints what would be downloaded (and checks every source) without
# downloading anything. Downloads are the tested versions in versions.json
# (checksums checked); -Latest takes each one's newest release instead.
# -Theme puts ES-DE's Iconic theme in ES-DE\themes and makes it ES-DE's
# theme (Textlist, light colors - as the arcade uses it), unless someone
# already picked another one.
# -Repair (Setup's Repair): ES-DE and every emulator already in the folder
# whose program has gone missing are downloaded again over their folder
# (settings and saves in it stay); nothing new is added.
param(
    [Parameter(Mandatory)] [string]$GamesDir,
    [switch]$WithEsDe,
    [string]$Emulators = '',
    [switch]$ListOnly,
    [switch]$Latest,
    [switch]$Repair,
    [switch]$Theme
)
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'catalog.ps1')

if ($Repair) {
    $esdeHere = Test-Path (Join-Path $GamesDir 'ES-DE')
    $root = if ($esdeHere) { Join-Path $GamesDir 'ES-DE\Emulators' } else { Join-Path $GamesDir 'Emulators' }
    $broken = @(foreach ($key in $Catalog.Keys) {
        $dir = Join-Path $root $Catalog[$key].Folder
        if ((Test-Path $dir) -and -not (Get-ChildItem -Path $dir -Filter $Catalog[$key].Exe -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1)) { $key }
    })
    $esdeBroken = $esdeHere -and -not (Test-Path (Join-Path $GamesDir 'ES-DE\ES-DE.exe'))
    if (-not $broken -and -not $esdeBroken) {
        Write-Step 'ES-DE and the emulators are all there: nothing to repair'
        exit 0
    }
    Write-Step "Repairing: $((@($(if ($esdeBroken) { 'ES-DE' })) + $broken) -join ', ')"
    $Emulators = $broken -join ','
    # The emulators live in ES-DE's folder either way; only download ES-DE
    # itself when it's the one missing.
    $WithEsDe = [switch]$esdeHere
    $script:SkipEsDe = -not $esdeBroken
}

$wanted = @($Emulators -split '[,\s]+' | Where-Object { $_ } | ForEach-Object { $_.ToLowerInvariant() })
if ($wanted -contains 'all') { $wanted = @($Catalog.Keys) }
$unknown = @($wanted | Where-Object { -not $Catalog.Contains($_) })
if ($unknown) { throw "Unknown emulator(s): $($unknown -join ', '). Known: $($Catalog.Keys -join ', ')" }

$esdeDir = Join-Path $GamesDir 'ES-DE'
# With ES-DE (being installed, or there from before) the emulators go in its
# folder, where its find rules look.
$hasEsDe = $WithEsDe -or (Test-Path (Join-Path $esdeDir 'ES-DE.exe'))
$emuRoot = if ($hasEsDe) { Join-Path $esdeDir 'Emulators' } else { Join-Path $GamesDir 'Emulators' }
$failed = @()
$installed = @()

if (-not $ListOnly) { New-Item -ItemType Directory -Force $GamesDir | Out-Null }

if ($WithEsDe -and -not $script:SkipEsDe) {
    Write-Step 'ES-DE (the game library you browse with a controller)'
    try {
        $src = Get-CatalogDownload 'esde' -Latest:$Latest
        Write-Note "$($src.Name) ($($src.Version)$(if (-not $src.Pinned) { ', newest' }))"
        if (-not $ListOnly) {
            Expand-Download (Save-CatalogDownload 'esde' $src) $esdeDir
            Save-InstalledVersion 'esde' $src.Version
            $installed += "ES-DE $($src.Version)"
        }
    } catch {
        Write-Note "FAILED: $($_.Exception.Message)"
        $failed += 'ES-DE'
    }
}

if ($Theme -and -not $ListOnly) {
    Write-Step 'Iconic theme for ES-DE (about 190 MB)'
    try {
        if (-not (Test-Path (Join-Path $esdeDir 'ES-DE.exe'))) { throw "ES-DE isn't in $esdeDir" }
        $themeDir = Join-Path $esdeDir 'themes\iconic-es-de'
        if (Test-Path (Join-Path $themeDir 'theme.xml')) {
            Write-Note 'already installed'
        } else {
            $src = Get-CatalogDownload 'iconic' -Latest:$Latest
            Write-Note "$($src.Name) ($($src.Version)$(if (-not $src.Pinned) { ', newest' }))"
            Expand-Download (Save-CatalogDownload 'iconic' $src) $themeDir
            Save-InstalledVersion 'iconic' $src.Version
            $installed += "Iconic theme $($src.Version)"
        }
        # ES-DE's settings: in ES-DE\ES-DE for the portable ES-DE Setup installs.
        $esData = if (Test-Path (Join-Path $esdeDir 'portable.txt')) { Join-Path $esdeDir 'ES-DE' } else { Join-Path $env:USERPROFILE 'ES-DE' }
        $settingsFile = Join-Path $esData 'settings\es_settings.xml'
        New-Item -ItemType Directory -Force (Split-Path $settingsFile) | Out-Null
        $lines = @(if (Test-Path $settingsFile) { Get-Content $settingsFile } else { '<?xml version="1.0"?>' })
        $current = ($lines | Where-Object { $_ -match 'name="Theme"' } | Select-Object -First 1) -replace '.*value="([^"]*)".*', '$1'
        if ($current -and $current -notin 'linear-es-de', 'iconic-es-de') {
            Write-Note "ES-DE already uses the theme $current - keeping it (pick Iconic in ES-DE's UI settings)"
        } else {
            foreach ($s in @(@('Theme', 'iconic-es-de'), @('ThemeVariant', 'textlist'), @('ThemeColorScheme', 'light-default'))) {
                $line = "<string name=`"$($s[0])`" value=`"$($s[1])`" />"
                $at = @(for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match "name=`"$($s[0])`"") { $i } })
                if ($at) { $lines[$at[0]] = $line } else { $lines += $line }
            }
            $lines | Set-Content -Path $settingsFile -Encoding UTF8
            Write-Note "ES-DE's theme: Iconic"
        }
    } catch {
        Write-Note "FAILED: $($_.Exception.Message)"
        $failed += 'Iconic theme'
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
            try { Install-RetroArchCores $dir -Latest:$Latest } catch { Write-Note "cores FAILED: $($_.Exception.Message)" }
        }
        Save-InstalledVersion $key $src.Version
        $installed += "$($entry.Name) $($src.Version)"
    } catch {
        Write-Note "FAILED: $($_.Exception.Message)"
        $failed += $entry.Name
    }
}

# ES-DE has no Switch 2 system: add one (custom_systems) that starts Lichii,
# its ROMs\switch2 folder, and Switch 2 pictures for the Iconic theme. Safe
# to run again: it only adds what's missing.
function Add-EsDeSwitch2 {
    $esData = if (Test-Path (Join-Path $esdeDir 'portable.txt')) { Join-Path $esdeDir 'ES-DE' } else { Join-Path $env:USERPROFILE 'ES-DE' }
    $custom = Join-Path $esData 'custom_systems'
    New-Item -ItemType Directory -Force $custom | Out-Null

    # Added as text before the closing tag, so the file (maybe edited by
    # hand, with comments) keeps its own layout.
    function Add-ToEsDeList([string]$File, [string]$Root, [string]$Find, [string]$Block) {
        $text = if (Test-Path $File) { [IO.File]::ReadAllText($File) } else { "<?xml version=`"1.0`"?>`r`n<$Root>`r`n</$Root>`r`n" }
        if ($text -match $Find) { return $false }
        $end = $text.LastIndexOf("</$Root>")
        if ($end -lt 0) { throw "$File has no </$Root>" }
        $text = $text.Substring(0, $end).TrimEnd() + "`r`n" + $Block.Trim("`r`n") + "`r`n</$Root>" + $text.Substring($end + "</$Root>".Length)
        [void][xml]$text
        [IO.File]::WriteAllText($File, $text)
        return $true
    }

    $file = Join-Path $custom 'es_systems.xml'
    $added = Add-ToEsDeList $file 'systemList' '<name>\s*switch2\s*</name>' @'
    <!-- switch2: added by Luma Arcade Setup. ES-DE has no Switch 2 system;
         Lichii (Emulators\lichii) runs it. -->
    <system>
        <name>switch2</name>
        <fullname>Nintendo Switch 2</fullname>
        <path>%ROMPATH%\switch2</path>
        <extension>.lnk .LNK .nca .NCA .nro .NRO .nso .NSO .nsp .NSP .xci .XCI</extension>
        <command label="Lichii (Standalone)">%EMULATOR_LICHII% -f -g %ROM%</command>
        <command label="Shortcut">%HIDEWINDOW% %ESCAPESPECIALS% %EMULATOR_OS-SHELL% /C %ROM%</command>
        <platform>switch</platform>
        <theme>switch2</theme>
    </system>
'@
    if ($added) { Write-Note "ES-DE: added the Nintendo Switch 2 system ($file)" }

    [void](Add-ToEsDeList (Join-Path $custom 'es_find_rules.xml') 'ruleList' '<emulator\s+name="LICHII"' @'
    <emulator name="LICHII">
        <!-- Nintendo Switch 2 emulator Lichii -->
        <rule type="systempath">
            <entry>lichii.exe</entry>
        </rule>
        <rule type="staticpath">
            <entry>%ESPATH%\Emulators\lichii\lichii.exe</entry>
            <entry>%ESPATH%\..\Emulators\lichii\lichii.exe</entry>
        </rule>
    </emulator>
'@)

    $roms = Join-Path $esdeDir 'ROMs'
    if (Test-Path $roms) { New-Item -ItemType Directory -Force (Join-Path $roms 'switch2') | Out-Null }

    # Iconic has Switch pictures but none for Switch 2: the same console
    # pictures, a Switch 2 logo, and its own name and details.
    $art = Join-Path $esdeDir 'themes\iconic-es-de\_inc\systems'
    if (Test-Path $art) {
        foreach ($dir in Get-ChildItem -Directory $art) {
            $from = Join-Path $dir.FullName 'switch.webp'
            $to = Join-Path $dir.FullName 'switch2.webp'
            if ((Test-Path $from) -and -not (Test-Path $to)) { Copy-Item $from $to }
        }
        $logo = Join-Path $PSScriptRoot 'switch2.webp'
        if (Test-Path $logo) { Copy-Item $logo (Join-Path $art 'carousel-icons\switch2.webp') -Force }
        $meta = Join-Path $art 'metadata-global\switch.xml'
        if (Test-Path $meta) {
            $xml = Get-Content -Raw $meta
            $xml = $xml -replace '<systemName>[^<]*', '<systemName>Nintendo Switch 2' `
                        -replace '<systemDescription>[^<]*', '<systemDescription>The Nintendo Switch 2 is the successor to the Nintendo Switch: a hybrid console with a larger 1080p screen, magnetic Joy-Con 2 controllers that also work as a mouse, and up to 4K output on a TV. It plays most Switch games as well as its own. It was released worldwide on June 5, 2025, at a retail price of $449.99.' `
                        -replace '<systemReleaseYear>[^<]*', '<systemReleaseYear>2025' `
                        -replace '<systemReleaseDate>[^<]*', '<systemReleaseDate>2025-06-05' `
                        -replace '<systemReleaseDateFormated>[^<]*', '<systemReleaseDateFormated>June 5, 2025'
            Set-Content -Path (Join-Path $art 'metadata-global\switch2.xml') -Value $xml -Encoding UTF8
        }
        $meta = Join-Path $art 'metadata-custom\switch.xml'
        if (Test-Path $meta) {
            (Get-Content -Raw $meta) -replace '<text>Nintendo Switch</text>', '<text>Nintendo Switch 2</text>' |
                Set-Content -Path (Join-Path $art 'metadata-custom\switch2.xml') -Encoding UTF8
        }
    }
}

if (-not $ListOnly -and $hasEsDe -and ($wanted -contains 'lichii') -and (Test-Path (Join-Path $emuRoot 'lichii\lichii.exe'))) {
    Write-Step 'ES-DE: Nintendo Switch 2 system for Lichii'
    try {
        Add-EsDeSwitch2
        # Eden's keys, when it's here, so Lichii doesn't ask for them again.
        $keys = Join-Path $emuRoot 'eden\user\keys'
        $lichiiKeys = Join-Path $emuRoot 'lichii\user\keys'
        if ((Test-Path (Join-Path $keys 'prod.keys')) -and -not (Test-Path (Join-Path $lichiiKeys 'prod.keys'))) {
            New-Item -ItemType Directory -Force $lichiiKeys | Out-Null
            Copy-Item (Join-Path $keys '*') $lichiiKeys -Recurse -Force
            Write-Note "copied Eden's keys"
        }
    } catch {
        Write-Note "FAILED: $($_.Exception.Message)"
        $failed += 'ES-DE Switch 2 system'
    }
}

if ($ListOnly) {
    if ($failed) { Write-Output "Could not resolve: $($failed -join '; ')"; exit 1 }
    exit 0
}
if ($Repair) {
    # The shortcuts, setup copy and READ ME from the first install stay.
    if ($failed) { Write-Step "Couldn't repair: $($failed -join '; ')"; exit 1 }
    Write-Step 'Repaired'
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
if ($hasEsDe) {
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
$(if ($hasEsDe) { "ES-DE:     $esdeDir\ES-DE.exe  (shortcut on the desktop)
Games:     put them in $esdeDir\ROMs\<system>\ - ES-DE offers to create
           these folders the first time it starts (e.g. ROMs\snes, ROMs\ps2)." })

BIOS and firmware are NOT included - dump them from consoles you own:
  - RetroArch (PS1, PC Engine CD, ...): $emuRoot\RetroArch-Win64\system\
  - PCSX2 (PS2):   $emuRoot\PCSX2-Qt\bios\
  - DuckStation:   $emuRoot\duckstation\bios\
  - RPCS3 (PS3):   in RPCS3: File > Install Firmware (PS3UPDAT.PUP)
  - Vita3K:        in Vita3K: install the firmware (PSVUPDAT.PUP)
  - xemu (Xbox):   point xemu at your BIOS/MCPX/HDD image in its settings
  - Lichii (Switch 2): in Lichii: Tools > Install Decryption Keys, then
                   Tools > Install Firmware. Switch 2 games go in ROMs\switch2\

To add or update emulators later, run as administrator:
  powershell -ExecutionPolicy Bypass -File "$GamesDir\setup\install-games.ps1" -GamesDir "$GamesDir"$(if ($hasEsDe) { ' -WithEsDe' }) -Emulators <names>
  Names: $($Catalog.Keys -join ', ')
  (add -Latest for each one's newest release instead of the tested version)
"@ | Set-Content -Path $readme -Encoding UTF8

if ($failed) {
    Write-Step "Done, but these failed: $($failed -join '; ') (see $readme)"
} else {
    Write-Step "Done. See $readme"
}
