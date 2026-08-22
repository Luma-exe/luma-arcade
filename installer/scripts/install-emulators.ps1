# Downloads and stages emulators into ES-DE's expected
# %ESPATH%\Emulators\<Name>\ locations, where %ESPATH% is the folder
# containing ES-DE.exe. ES-DE ships default es_find_rules.xml entries that
# already look for emulators at these exact paths — confirmed against its
# actual GitLab source, not guessed — so placing a build there is normally
# enough with no es_systems.xml/es_find_rules.xml editing needed.
#
# Every step is best-effort/non-fatal, same philosophy as
# install-deps.ps1: a failed download for one emulator is logged and
# skipped, it doesn't abort installing the others.
#
# param(1): $EsdePath — full path to ES-DE.exe (so %ESPATH% can be derived)
# param(2): $Selected — comma-separated list of emulator ids to install,
#   e.g. "cemu,dolphin,duckstation". Valid ids are the keys of $Emulators
#   below. Pass "all" to install everything that can be auto-installed.
param(
    [Parameter(Mandatory = $true)]
    [string]$EsdePath,
    [Parameter(Mandatory = $true)]
    [string]$Selected
)

$ErrorActionPreference = "Continue"
$EmulatorsDir = Join-Path (Split-Path $EsdePath -Parent) "Emulators"
New-Item -ItemType Directory -Path $EmulatorsDir -Force | Out-Null

function Write-Step($msg) {
    Write-Host "=== $msg ==="
}

$EsdeUserDir = Join-Path $env:USERPROFILE "ES-DE"

# ES-DE picks the *first* <command> listed per system in es_systems.xml as
# the default, and for most systems that's a RetroArch core — not the
# standalone emulator this script actually installs. Without overriding
# that, every game fails to launch with "core file not found" even though
# the real emulator is sitting right there correctly installed (confirmed
# live: nds/wii/psx games all failed this exact way before this function
# existed). ES-DE stores the override as an <alternativeEmulator><label>
# tag as a sibling of <gameList> in each system's own gamelist.xml — same
# place/format it writes itself when you set this via its in-app menu
# (GuiAlternativeEmulators.cpp / GamelistFileParser.cpp in ES-DE's source).
function Set-DefaultEmulator($EsdeSystem, $Label) {
    $dir = Join-Path $EsdeUserDir "gamelists\$EsdeSystem"
    $path = Join-Path $dir "gamelist.xml"
    New-Item -ItemType Directory -Path $dir -Force | Out-Null

    $block = "<alternativeEmulator>`n    <label>$Label</label>`n</alternativeEmulator>`n"

    if (Test-Path $path) {
        $content = Get-Content $path -Raw
        if ($content -match "<alternativeEmulator>") {
            return  # already set (by ES-DE itself, or a previous run of this script) -- don't clobber
        }
        if ($content -match "^\s*<\?xml[^>]*\?>\s*") {
            $newContent = $content -replace "(^\s*<\?xml[^>]*\?>\s*)", "`$1`n$block"
        } else {
            $newContent = "$block$content"
        }
    } else {
        $newContent = "<?xml version=`"1.0`"?>`n$block<gameList>`n</gameList>`n"
    }

    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($path, $newContent, $utf8NoBom)
    Write-Host "Set $EsdeSystem's default emulator to '$Label'."
}

# melonDS ships with every keyboard AND joystick binding unset (-1) by
# design (confirmed against its actual source, Config.cpp's DefaultInts —
# every Instance*.Keyboard/Instance*.Joystick key defaults to -1, there's
# no baked-in control scheme at all) so a fresh install has literally no
# way to control the game until someone opens its Input Config dialog by
# hand. Since games here are played over Sunshine with a gamepad (a
# virtual XInput controller via ViGEmBus), this writes joystick bindings
# using SDL2's fixed button order for XInput devices on Windows (A=0,
# B=1, X=2, Y=3, LB=4, RB=5, Back=6, Start=7; D-pad reported as hat 0,
# encoded per melonDS's own MapButton.h scheme: 0x100 | direction-bit),
# plus a conventional keyboard fallback (arrows + X/Z/S/A, matching the
# common DS-emulator convention) for anyone driving it from a keyboard.
# melonDS's config loader (toml11-based, same DefaultList-driven merge
# used for every other key) fills in anything this file doesn't specify,
# so writing just these two sections is enough — it doesn't need to be a
# complete config.
function Set-MelonDSDefaultControls($MelonDSDir) {
    $tomlPath = Join-Path $MelonDSDir "melonDS.toml"

    $keyboardBlock = @"
[Instance0.Keyboard]
A = 88
B = 90
X = 83
Y = 65
L = 81
R = 87
Start = 16777220
Select = 16777219
Up = 16777235
Down = 16777237
Left = 16777234
Right = 16777236
"@

    $joystickBlock = @"
[Instance0.Joystick]
A = 0
B = 1
X = 2
Y = 3
L = 4
R = 5
Start = 7
Select = 6
Up = 257
Down = 260
Left = 264
Right = 258
"@

    $utf8NoBom = New-Object System.Text.UTF8Encoding $false

    if (-not (Test-Path $tomlPath)) {
        # Fresh install, melonDS hasn't run yet to generate its own config --
        # write a minimal file with just the sections we care about.
        [System.IO.File]::WriteAllText($tomlPath, "$keyboardBlock`n`n$joystickBlock`n", $utf8NoBom)
        Write-Host "Wrote default melonDS keyboard/joystick controls to $tomlPath"
        return
    }

    $content = Get-Content $tomlPath -Raw
    foreach ($pair in @(
        @{ section = "Instance0.Keyboard"; block = $keyboardBlock },
        @{ section = "Instance0.Joystick"; block = $joystickBlock }
    )) {
        $pattern = "(?ms)^\[$([regex]::Escape($pair.section))\].*?(?=^\[|\z)"
        if ($content -match $pattern) {
            $content = [regex]::Replace($content, $pattern, ($pair.block + "`n"), 1)
        } else {
            $content += "`n$($pair.block)`n"
        }
    }
    [System.IO.File]::WriteAllText($tomlPath, $content, $utf8NoBom)
    Write-Host "Patched default melonDS keyboard/joystick controls into $tomlPath"
}

# ES-DE (like every other frontend) hides a system entirely from its menu
# when its ROM folder has zero recognized game files in it -- confirmed
# live: xbox/xbox360 never showed up on lumaplayground.com at all, and it
# turned out ROMS\xbox and ROMS\xbox360 simply didn't exist yet, nothing
# to do with the emulator install. That part genuinely can't be fixed by
# this script -- it needs the user's own game files -- but creating the
# folder ahead of time means dropping files in later is all that's left,
# rather than also having to know ES-DE's folder-naming convention.
function Get-RomPath {
    $settingsPath = Join-Path $EsdeUserDir "settings\es_settings.xml"
    if (Test-Path $settingsPath) {
        $content = Get-Content $settingsPath -Raw
        if ($content -match '<string name="ROMDirectory" value="([^"]*)"') {
            $val = $matches[1]
            if ($val) { return $val }
        }
    }
    return (Join-Path $EsdeUserDir "ROMS")
}

function Ensure-RomFolder($EsdeSystem) {
    $romPath = Get-RomPath
    $dir = Join-Path $romPath $EsdeSystem
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

# id -> ES-DE system folder name(s) under ROMS\, for Ensure-RomFolder.
$RomSystemsForId = @{
    "cemu"        = @("wiiu")
    "3ds"         = @("n3ds")
    "duckstation" = @("psx")
    "melonds"     = @("nds")
    "pcsx2"       = @("ps2")
    "ppsspp"      = @("psp")
    "rpcs3"       = @("ps3")
    "shadps4"     = @("ps4")
    "vita3k"      = @("psvita")
    "xemu"        = @("xbox")
    "xenia"       = @("xbox360")
    "switch"      = @("switch")
    "dolphin"     = @("gc", "wii")
    "flycast"     = @("dreamcast", "naomi", "naomi2", "naomigd", "atomiswave")
    "ruffle"      = @("flash")
    "hypseus"     = @("daphne")
    "tsugaru"     = @("fmtowns")
    "supermodel"  = @("model3")
    "scummvm"     = @("scummvm")
    "easyrpg"     = @("easyrpg")
    "dosbox-staging" = @("dos")
    "dosbox-x"    = @("windows9x", "windows3x")
    "vpinball"    = @("vpinball")
    "kemulator"   = @("j2me")
    "teknoparrot" = @("type-x")
}

function Ensure-7Zip {
    $sevenZip = "$env:ProgramFiles\7-Zip\7z.exe"
    if (Test-Path $sevenZip) { return $sevenZip }
    Write-Step "Installing 7-Zip (needed to extract some emulators' .7z releases)"
    try {
        $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/ip7z/7zip/releases/latest"
        $asset = $rel.assets | Where-Object { $_.name -like "*-x64.exe" } | Select-Object -First 1
        $exe = "$env:TEMP\7zip-installer.exe"
        Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $exe
        Start-Process -FilePath $exe -ArgumentList "/S" -Wait -Verb RunAs
        if (Test-Path $sevenZip) { return $sevenZip }
    } catch {
        Write-Host "7-Zip install failed: $($_.Exception.Message)"
    }
    return $null
}

# Downloads the first matching release asset and extracts it into
# $EmulatorsDir\$DestFolder, flattening one level of nesting if the
# archive wraps everything in a single subfolder (common — moonlight-web-
# stream's release did the same). Supports both GitHub's releases API and
# Gitea/Forgejo's (used by Eden, which moved off GitHub after Nintendo
# takedown notices) — same asset-list shape, different endpoint and
# "latest" semantics (GitHub has a dedicated /releases/latest object,
# Gitea/Forgejo doesn't reliably, so it's queried as a length-1 list and
# the first element is used instead).
function Install-Emulator($Name, $Kind, $Repo, $AssetPattern, $DestFolder, $ExpectedExe) {
    Write-Step $Name
    $dest = Join-Path $EmulatorsDir $DestFolder
    if (Test-Path (Join-Path $dest $ExpectedExe)) {
        Write-Host "$Name already staged, skipping."
        return
    }
    try {
        if ($Kind -eq "gitea") {
            $rel = (Invoke-RestMethod -Uri "https://git.eden-emu.dev/api/v1/repos/$Repo/releases?limit=1")[0]
        } elseif ($Kind -eq "github-list") {
            # Some GitHub repos (e.g. TOWNSEMU/Tsugaru) never mark any
            # release "latest", so /releases/latest 404s even though real
            # releases exist -- same underlying issue as Gitea above, just
            # on GitHub itself. Query the list and take the first (newest)
            # entry instead.
            $rel = (Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=1")[0]
        } else {
            $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
        }
        $asset = $rel.assets | Where-Object { $_.name -like $AssetPattern -and $_.name -notlike "*.sha256" } | Select-Object -First 1
        if (-not $asset) {
            Write-Host "$Name`: no release asset matched '$AssetPattern' — check $Repo's releases manually, see README."
            return
        }
        $archive = "$env:TEMP\$($asset.name)"
        Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $archive
        New-Item -ItemType Directory -Path $dest -Force | Out-Null

        if ($archive -like "*.7z") {
            $sevenZip = Ensure-7Zip
            if (-not $sevenZip) {
                Write-Host "$Name`: couldn't get 7-Zip, skipping extraction. Extract $archive manually into $dest"
                return
            }
            & $sevenZip x $archive "-o$dest" -y | Out-Null
        } else {
            Expand-Archive -Path $archive -DestinationPath $dest -Force
        }
        Remove-Item $archive -Force -ErrorAction SilentlyContinue

        # Flatten nesting if the exe isn't where expected but is somewhere
        # further down (e.g. archive contains a single top folder, or --
        # confirmed live with DOSBox-X's release zip -- two of them
        # stacked). Search for wherever the exe actually landed and pull
        # that whole containing folder's contents up to $dest, rather than
        # assuming exactly one level.
        if (-not (Test-Path (Join-Path $dest $ExpectedExe))) {
            $found = Get-ChildItem $dest -Recurse -Filter (Split-Path $ExpectedExe -Leaf) -File -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($found -and $found.DirectoryName -ne $dest) {
                Get-ChildItem $found.DirectoryName | Move-Item -Destination $dest -Force
                # Clean up whatever now-empty nested folders are left behind.
                Get-ChildItem $dest -Directory -Recurse -ErrorAction SilentlyContinue |
                    Sort-Object { $_.FullName.Length } -Descending |
                    Where-Object { (Get-ChildItem $_.FullName -Force -ErrorAction SilentlyContinue).Count -eq 0 } |
                    Remove-Item -Force -ErrorAction SilentlyContinue
            }
        }

        if (Test-Path (Join-Path $dest $ExpectedExe)) {
            Write-Host "$Name staged at $dest."
        } else {
            Write-Host "$Name`: extracted but $ExpectedExe not found where expected — check $dest manually."
        }
    } catch {
        Write-Host "$Name install failed: $($_.Exception.Message) — install manually, see README."
    }
}

# id -> { kind, repo, pattern, folder, exe }. Folder/exe values match
# ES-DE's actual bundled es_find_rules.xml staticpath entries — verified
# against its GitLab source this session, not guessed. "eden" is the one
# exception needing no verification guesswork at all: ES-DE's es_systems.xml
# already references %EMULATOR_EDEN% directly and es_find_rules.xml already
# has a matching EDEN rule pointing at this exact folder — ES-DE shipped
# support for it before this script did.
$Emulators = @{
    "cemu"        = @{ kind = "github"; repo = "cemu-project/Cemu"; pattern = "cemu-*-windows-x64.zip"; folder = "cemu"; exe = "Cemu.exe" }
    "3ds"         = @{ kind = "github"; repo = "azahar-emu/azahar"; pattern = "azahar-windows-msvc-*.zip"; folder = "Citra\nightly-mingw"; exe = "azahar.exe" }
    "duckstation" = @{ kind = "github"; repo = "stenzek/duckstation"; pattern = "duckstation-windows-x64-release.zip"; folder = "duckstation"; exe = "duckstation-qt-x64-ReleaseLTCG.exe" }
    "melonds"     = @{ kind = "github"; repo = "melonDS-emu/melonDS"; pattern = "melonDS-*-windows-x86_64.zip"; folder = "melonDS"; exe = "melonDS.exe" }
    "pcsx2"       = @{ kind = "github"; repo = "PCSX2/pcsx2"; pattern = "pcsx2-*-windows-x64-Qt.7z"; folder = "PCSX2-Qt"; exe = "pcsx2-qt.exe" }
    "ppsspp"      = @{ kind = "github"; repo = "hrydgard/ppsspp"; pattern = "PPSSPP-*-Windows-x64.zip"; folder = "PPSSPP"; exe = "PPSSPPWindows64.exe" }
    "rpcs3"       = @{ kind = "github"; repo = "RPCS3/rpcs3-binaries-win"; pattern = "rpcs3-*win64_msvc.7z"; folder = "RPCS3"; exe = "rpcs3.exe" }
    "shadps4"     = @{ kind = "github"; repo = "shadps4-emu/shadPS4"; pattern = "shadps4-win64-sdl-*.zip"; folder = "shadPS4"; exe = "shadPS4.exe" }
    "vita3k"      = @{ kind = "github"; repo = "Vita3K/Vita3K"; pattern = "windows-latest.zip"; folder = "Vita3K"; exe = "Vita3K.exe" }
    "xemu"        = @{ kind = "github"; repo = "xemu-project/xemu"; pattern = "xemu-*-windows-x86_64.zip"; folder = "xemu"; exe = "xemu.exe" }
    "xenia"       = @{ kind = "github"; repo = "xenia-canary/xenia-canary-releases"; pattern = "xenia_canary_windows_.zip"; folder = "xenia_canary"; exe = "xenia_canary.exe" }
    "switch"      = @{ kind = "gitea"; repo = "eden-emu/eden"; pattern = "Eden-Windows-*-amd64-msvc-standard.zip"; folder = "eden"; exe = "eden.exe" }
    "flycast"     = @{ kind = "github"; repo = "flyinghead/flycast"; pattern = "flycast-win64-*.zip"; folder = "flycast"; exe = "flycast.exe" }
    "ruffle"      = @{ kind = "github"; repo = "ruffle-rs/ruffle"; pattern = "ruffle-*-windows-x86_64.zip"; folder = "ruffle"; exe = "ruffle.exe" }
    "hypseus"     = @{ kind = "github"; repo = "DirtBagXon/hypseus-singe"; pattern = "Hypseus.Singe-*-win64.zip"; folder = "Hypseus Singe"; exe = "hypseus.exe" }
    "tsugaru"     = @{ kind = "github-list"; repo = "captainys/TOWNSEMU"; pattern = "windows_binary_latest.zip"; folder = "tsugaru"; exe = "Tsugaru_CUI.exe" }
    "supermodel"  = @{ kind = "github"; repo = "trzy/Supermodel"; pattern = "supermodel-*-windows.zip"; folder = "Supermodel"; exe = "Supermodel.exe" }
    "dosbox-staging" = @{ kind = "github"; repo = "dosbox-staging/dosbox-staging"; pattern = "dosbox-staging-windows-x64-v*.zip"; folder = "dosbox-staging"; exe = "dosbox.exe" }
    "dosbox-x"    = @{ kind = "github"; repo = "joncampbell123/dosbox-x"; pattern = "dosbox-x-mingw64-*-portable.zip"; folder = "DOSBox-X"; exe = "dosbox-x.exe" }
    "vpinball"    = @{ kind = "github"; repo = "vpinball/vpinball"; pattern = "Developer.VPinballX_GL-*-Release-win-x64.zip"; folder = "VPinballX"; exe = "VPinballX_GL64.exe" }
    "kemulator"   = @{ kind = "github"; repo = "shinovon/KEmulator"; pattern = "kemnnx64.v*.zip"; folder = "KEmulator"; exe = "KEmulator.bat" }
    "teknoparrot" = @{ kind = "github"; repo = "teknogods/TeknoParrotUI"; pattern = "TeknoParrotUi.zip"; folder = "TeknoParrot"; exe = "TeknoParrotUi.exe" }
}

# TeknoParrot (type-x / modern PC-based arcade boards) gets downloaded
# and staged like everything else above, but deliberately has no entry
# in $DefaultEmulatorTargets and no custom_systems find-rule -- checked
# ES-DE's own es_systems.xml and es_find_rules.xml directly, and neither
# one has ever heard of TeknoParrot at all, unlike every other emulator
# here. That's not an oversight to work around: TeknoParrot doesn't take
# a ROM/ISO path as an argument the way an emulator normally does --
# each game is its own hand-configured "profile" (XML file naming the
# game's actual executable, DLL patches, per-title I/O config) that has
# to be set up once inside TeknoParrot itself before it's launchable at
# all, the same fundamental one-time-setup-per-game shape as Vita3K's
# library on this box. ES-DE's own "type-x" system already matches that
# shape exactly -- its one and only command is "Shortcut or script",
# meaning each game is just a .bat/.lnk in ROMS\type-x that calls
# "TeknoParrotUi.exe -run <profile>.xml" itself. That's already the
# correct, ES-DE-native way to wire TeknoParrot in -- nothing to
# override, it just needs to actually be on disk, which is what this
# does.
#
# A few of the systems from the ES-DE ROMS coverage pass (Sega Model 2,
# Saturn's Kronos/Yaba Sanshiro 2, Apple IIGS's KEGS, classic Mac's
# Basilisk II/SheepShaver) don't get an entry above even though ES-DE has
# a built-in find-rule for their standalone emulator -- checked each one
# specifically and none of them publish Windows builds through a GitHub
# releases API this script can query: Model 2 Emulator and KEGS are
# closed-source freeware with no official repo at all, and Kronos/
# macemu (Basilisk II + SheepShaver) only publish Linux/macOS builds via
# GitHub, Windows builds are distributed elsewhere. Installing those
# would mean guessing at a download source, which is exactly what this
# script has avoided everywhere else -- left for manual install if
# wanted, same as the README already does for anything unverified.

# id -> [ { esdeSystem, label } ]. Only systems where es_systems.xml's
# *first*-listed (default) command is a RetroArch core rather than the
# standalone emulator this script installs — verified per-system against
# ES-DE's actual es_systems.xml this session, not guessed. Left out
# deliberately: cemu (wiiu), xenia (xbox360), xemu (xbox), switch (eden)
# already default to their standalone command since no RetroArch
# alternative exists for those systems; shadps4 (ps4) also has no
# RetroArch alternative, but its own default command expects a specific
# ROM format (shortcut/script files) that depends on how the user's
# actual dumps are structured -- not something to override blindly.
#
# ps3's default command ("RPCS3 Shortcut (Standalone)") runs the ROM file
# itself via cmd.exe, which only works if the ROM is a .lnk/script that
# launches RPCS3 with the right args -- for a plain .iso (the common case)
# that silently does nothing, no error, nothing opens. Confirmed live:
# real .iso dumps on lumaplayground.com just sat there. "RPCS3 ISO
# (Standalone)" and "RPCS3 Directory (Standalone)" are actually the exact
# same command string in ES-DE's es_systems.xml (both
# "%EMULATOR_RPCS3% --no-gui %ROM%"), so this one label covers both plain
# .iso files and folder-based (.ps3dir) dumps.
$DefaultEmulatorTargets = @{
    "3ds"         = @(@{ esdeSystem = "n3ds"; label = "Azahar (Standalone)" })
    "duckstation" = @(@{ esdeSystem = "psx"; label = "DuckStation (Standalone)" })
    "melonds"     = @(@{ esdeSystem = "nds"; label = "melonDS (Standalone)" })
    "pcsx2"       = @(@{ esdeSystem = "ps2"; label = "PCSX2 (Standalone)" })
    "ppsspp"      = @(@{ esdeSystem = "psp"; label = "PPSSPP (Standalone)" })
    "rpcs3"       = @(@{ esdeSystem = "ps3"; label = "RPCS3 ISO (Standalone)" })
    "dolphin"     = @(
        @{ esdeSystem = "gc"; label = "Dolphin (Standalone)" },
        @{ esdeSystem = "wii"; label = "Dolphin (Standalone)" }
    )
    "flycast"     = @(
        @{ esdeSystem = "dreamcast"; label = "Flycast (Standalone)" },
        @{ esdeSystem = "naomi"; label = "Flycast (Standalone)" },
        @{ esdeSystem = "naomi2"; label = "Flycast (Standalone)" },
        @{ esdeSystem = "naomigd"; label = "Flycast (Standalone)" },
        @{ esdeSystem = "atomiswave"; label = "Flycast (Standalone)" }
    )
    "scummvm"     = @(@{ esdeSystem = "scummvm"; label = "ScummVM (Standalone)" })
    "easyrpg"     = @(@{ esdeSystem = "easyrpg"; label = "EasyRPG Player (Standalone)" })
    "dosbox-staging" = @(@{ esdeSystem = "dos"; label = "DOSBox Staging (Standalone)" })
    "tsugaru"     = @(@{ esdeSystem = "fmtowns"; label = "Tsugaru (Standalone)" })
    "kemulator"   = @(@{ esdeSystem = "j2me"; label = "KEmulator (Standalone)" })
    # Not listed here because they're already ES-DE's first-listed
    # (default) command for their system, verified against es_systems.xml
    # directly, so no <alternativeEmulator> override is needed: ruffle
    # (flash), hypseus (daphne), supermodel (model3), vpinball (vpinball,
    # its only command), dosbox-x (windows9x, windows3x).
}

# RetroArch isn't distributed via GitHub release assets at all (only
# source tarballs) — official Windows builds come from libretro's own
# buildbot instead.
function Install-RetroArch {
    $Name = "RetroArch"
    $dest = Join-Path $EmulatorsDir "RetroArch-Win64"
    if (Test-Path (Join-Path $dest "retroarch.exe")) {
        Write-Host "$Name already staged, skipping."
        return
    }
    Write-Step $Name
    try {
        $sevenZip = Ensure-7Zip
        if (-not $sevenZip) {
            Write-Host "$Name`: couldn't get 7-Zip, skipping. Download manually from buildbot.libretro.com, see README."
            return
        }
        $archive = "$env:TEMP\RetroArch.7z"
        Invoke-WebRequest -UseBasicParsing -Uri "https://buildbot.libretro.com/nightly/windows/x86_64/RetroArch.7z" -OutFile $archive
        New-Item -ItemType Directory -Path $dest -Force | Out-Null
        & $sevenZip x $archive "-o$dest" -y | Out-Null
        Remove-Item $archive -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path (Join-Path $dest "retroarch.exe"))) {
            $inner = Get-ChildItem $dest -Directory | Select-Object -First 1
            if ($inner) {
                Get-ChildItem $inner.FullName | Move-Item -Destination $dest -Force
                Remove-Item $inner.FullName -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        Write-Host "$Name staged at $dest. Use RetroArch's own Online Updater (Main Menu -> Online Updater -> Core Downloader) to install cores for individual retro systems — not something this installer maintains a list for."
    } catch {
        Write-Host "$Name install failed: $($_.Exception.Message) — install manually, see README."
    }
}

# Dolphin (GameCube/Wii) has no GitHub release assets, and its own
# download page (dolphin-emu.org) sits behind an anti-bot JS challenge that
# blocks plain scripted requests (confirmed — curl/Invoke-WebRequest get a
# 403 challenge page, a real browser passes it fine). But the actual file
# CDN it links to (dl.dolphin-emu.org) is NOT behind that challenge —
# confirmed with a real browser, then verified the direct file URL alone
# returns a clean 200 with no challenge. Combined with GitHub's mirror of
# the dolphin-emu/dolphin repo (present purely as tags, e.g. "2606a",
# matching the download page's version numbering exactly), that's enough
# to build the real download URL without winget, an interactive session,
# or a browser at install time.
function Install-Dolphin {
    Write-Step "Dolphin"
    $dest = Join-Path $EmulatorsDir "Dolphin-x64"
    if (Test-Path (Join-Path $dest "Dolphin.exe")) {
        Write-Host "Dolphin already staged, skipping."
        return
    }
    try {
        # GitHub's tags API isn't sorted latest-first (a plain "2606" tag
        # can appear before its own "2606a" hotfix in the raw list) — sort
        # explicitly by the numeric part, then the hotfix letter suffix,
        # both descending, rather than trusting API order.
        $tags = Invoke-RestMethod -Uri "https://api.github.com/repos/dolphin-emu/dolphin/tags"
        $version = $tags |
            Where-Object { $_.name -match "^\d{4}a?$" } |
            Sort-Object -Property @{Expression = { [int]($_.name.Substring(0, 4)) }; Descending = $true }, @{Expression = { $_.name.Length }; Descending = $true } |
            Select-Object -First 1 -ExpandProperty name
        if (-not $version) {
            Write-Host "Couldn't determine the latest Dolphin version from GitHub tags — install manually, see README."
            return
        }
        $url = "https://dl.dolphin-emu.org/releases/$version/dolphin-$version-x64.7z"
        $archive = "$env:TEMP\dolphin-$version-x64.7z"
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive

        $sevenZip = Ensure-7Zip
        if (-not $sevenZip) {
            Write-Host "Couldn't get 7-Zip, skipping extraction. Extract $archive manually into $dest"
            return
        }
        New-Item -ItemType Directory -Path $dest -Force | Out-Null
        & $sevenZip x $archive "-o$dest" -y | Out-Null
        Remove-Item $archive -Force -ErrorAction SilentlyContinue

        # The 7z wraps everything in a "Dolphin-x64" subfolder — flatten it.
        if (-not (Test-Path (Join-Path $dest "Dolphin.exe"))) {
            $inner = Get-ChildItem $dest -Directory | Select-Object -First 1
            if ($inner -and (Test-Path (Join-Path $inner.FullName "Dolphin.exe"))) {
                Get-ChildItem $inner.FullName | Move-Item -Destination $dest -Force
                Remove-Item $inner.FullName -Recurse -Force -ErrorAction SilentlyContinue
            }
        }

        if (Test-Path (Join-Path $dest "Dolphin.exe")) {
            Write-Host "Dolphin $version staged at $dest."
            foreach ($t in $DefaultEmulatorTargets["dolphin"]) {
                Set-DefaultEmulator -EsdeSystem $t.esdeSystem -Label $t.label
            }
        } else {
            Write-Host "Dolphin extracted but Dolphin.exe not found where expected — check $dest manually."
        }
    } catch {
        Write-Host "Dolphin install failed: $($_.Exception.Message) — install manually, see README."
    }
}

# ScummVM and EasyRPG Player both publish real Windows builds, but not as
# GitHub release assets — GitHub's releases for both repos have zero
# attached binaries (confirmed via the API, not assumed). Their actual
# downloads live on their own sites at a versioned URL, e.g.
# downloads.scummvm.org/frs/scummvm/<version>/scummvm-<version>-win32-x86_64.zip
# — and that version number matches each repo's GitHub tag exactly, so
# the tag can still be queried from GitHub (consistent, well-formed API)
# and used to build the real download URL, the same trick already used
# for Dolphin's dl.dolphin-emu.org CDN.
function Install-ScummVM {
    Write-Step "ScummVM"
    $dest = Join-Path $EmulatorsDir "scummvm"
    if (Test-Path (Join-Path $dest "scummvm.exe")) {
        Write-Host "ScummVM already staged, skipping."
        return
    }
    try {
        $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/scummvm/scummvm/releases/latest"
        $version = $rel.tag_name -replace "^v", ""
        $url = "https://downloads.scummvm.org/frs/scummvm/$version/scummvm-$version-win32-x86_64.zip"
        $archive = "$env:TEMP\scummvm-$version-win32-x86_64.zip"
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive
        New-Item -ItemType Directory -Path $dest -Force | Out-Null
        Expand-Archive -Path $archive -DestinationPath $dest -Force
        Remove-Item $archive -Force -ErrorAction SilentlyContinue

        if (-not (Test-Path (Join-Path $dest "scummvm.exe"))) {
            $inner = Get-ChildItem $dest -Directory | Select-Object -First 1
            if ($inner -and (Test-Path (Join-Path $inner.FullName "scummvm.exe"))) {
                Get-ChildItem $inner.FullName | Move-Item -Destination $dest -Force
                Remove-Item $inner.FullName -Recurse -Force -ErrorAction SilentlyContinue
            }
        }

        if (Test-Path (Join-Path $dest "scummvm.exe")) {
            Write-Host "ScummVM $version staged at $dest."
            foreach ($t in $DefaultEmulatorTargets["scummvm"]) {
                Set-DefaultEmulator -EsdeSystem $t.esdeSystem -Label $t.label
            }
        } else {
            Write-Host "ScummVM extracted but scummvm.exe not found where expected — check $dest manually."
        }
    } catch {
        Write-Host "ScummVM install failed: $($_.Exception.Message) — install manually, see README."
    }
}

function Install-EasyRPG {
    Write-Step "EasyRPG Player"
    $dest = Join-Path $EmulatorsDir "EasyRPG"
    if (Test-Path (Join-Path $dest "Player.exe")) {
        Write-Host "EasyRPG Player already staged, skipping."
        return
    }
    try {
        $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/EasyRPG/Player/releases/latest"
        $version = $rel.tag_name
        $url = "https://easyrpg.org/downloads/player/$version/easyrpg-player-$version-windows.zip"
        $archive = "$env:TEMP\easyrpg-player-$version-windows.zip"
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive
        New-Item -ItemType Directory -Path $dest -Force | Out-Null
        Expand-Archive -Path $archive -DestinationPath $dest -Force
        Remove-Item $archive -Force -ErrorAction SilentlyContinue

        if (-not (Test-Path (Join-Path $dest "Player.exe"))) {
            $inner = Get-ChildItem $dest -Directory | Select-Object -First 1
            if ($inner -and (Test-Path (Join-Path $inner.FullName "Player.exe"))) {
                Get-ChildItem $inner.FullName | Move-Item -Destination $dest -Force
                Remove-Item $inner.FullName -Recurse -Force -ErrorAction SilentlyContinue
            }
        }

        if (Test-Path (Join-Path $dest "Player.exe")) {
            Write-Host "EasyRPG Player $version staged at $dest."
            foreach ($t in $DefaultEmulatorTargets["easyrpg"]) {
                Set-DefaultEmulator -EsdeSystem $t.esdeSystem -Label $t.label
            }
        } else {
            Write-Host "EasyRPG Player extracted but Player.exe not found where expected — check $dest manually."
        }
    } catch {
        Write-Host "EasyRPG Player install failed: $($_.Exception.Message) — install manually, see README."
    }
}

$selectedIds = $Selected.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($selectedIds -contains "all") {
    $selectedIds = $Emulators.Keys + @("retroarch", "dolphin", "scummvm", "easyrpg")
}

foreach ($id in $selectedIds) {
    if ($RomSystemsForId[$id]) {
        foreach ($sys in $RomSystemsForId[$id]) { Ensure-RomFolder -EsdeSystem $sys }
    }

    if ($id -eq "retroarch") {
        Install-RetroArch
        continue
    }
    if ($id -eq "dolphin") {
        Install-Dolphin
        continue
    }
    if ($id -eq "scummvm") {
        Install-ScummVM
        continue
    }
    if ($id -eq "easyrpg") {
        Install-EasyRPG
        continue
    }
    $e = $Emulators[$id]
    if (-not $e) {
        Write-Host "Unknown emulator id '$id', skipping."
        continue
    }
    Install-Emulator -Name $id -Kind $e.kind -Repo $e.repo -AssetPattern $e.pattern -DestFolder $e.folder -ExpectedExe $e.exe

    # Only point ES-DE at this as the default for its system(s) if the
    # install actually succeeded — a failed download shouldn't make ES-DE
    # default away from a working RetroArch core (if the user has one) to
    # an emulator that isn't actually there.
    $targets = $DefaultEmulatorTargets[$id]
    if ($targets -and (Test-Path (Join-Path $EmulatorsDir "$($e.folder)\$($e.exe)"))) {
        foreach ($t in $targets) {
            Set-DefaultEmulator -EsdeSystem $t.esdeSystem -Label $t.label
        }
    }

    if ($id -eq "melonds" -and (Test-Path (Join-Path $EmulatorsDir "$($e.folder)\$($e.exe)"))) {
        Set-MelonDSDefaultControls -MelonDSDir (Join-Path $EmulatorsDir $e.folder)
    }
}

# Some emulators need a find-rule override written to ES-DE's
# user-writable custom_systems/es_find_rules.xml, because either the
# bundled rule only searches the system PATH (n3ds's default command,
# "Azahar (Standalone)", resolves via %EMULATOR_AZAHAR%, whose bundled
# rule has no staticpath fallback into Emulators\ the way most other
# emulators do -- note this overrides AZAHAR specifically, not CITRA;
# CITRA's %EMULATOR_CITRA% variable is only used by the separate,
# non-default "Citra (Standalone)" command, overriding it had no effect
# on what actually launches by default), or ES-DE has no rule for it at
# all (KEmulator: the only automatable Windows J2ME build found,
# shinovon/KEmulator, is a Java rewrite shipping KEmulator.bat, not the
# original closed-source KEmulator.exe ES-DE's bundled rule looks for --
# confirmed live, the .exe genuinely isn't in that build's zip).
#
# This installer can run multiple times against the same install (the
# "install more emulators" repair path), and each run only knows about
# the ids passed in *that* run -- so this reads any overrides already in
# the file first and keeps them by emulator name, rather than
# regenerating the whole file from only this run's selection and
# silently deleting an earlier run's override (confirmed this would
# actually happen: installing just kemulator after an earlier 3ds run
# wiped the AZAHAR entry until this was fixed).
# Best-effort: the precise override-merge behavior wasn't verified
# against a real ES-DE run, only against its documented file-location
# convention.
$customDir = Join-Path $env:USERPROFILE "ES-DE\custom_systems"
$findRulesPath = Join-Path $customDir "es_find_rules.xml"

$overridesByName = @{}
if (Test-Path $findRulesPath) {
    $existing = Get-Content $findRulesPath -Raw
    $matches = [regex]::Matches($existing, '(?ms)^\s*<emulator name="([^"]+)">.*?</emulator>\s*$')
    foreach ($m in $matches) {
        $overridesByName[$m.Groups[1].Value] = $m.Value.Trim()
    }
}

if ($selectedIds -contains "3ds") {
    $azaharExe = Join-Path $EmulatorsDir "Citra\nightly-mingw\azahar.exe"
    if (Test-Path $azaharExe) {
        $overridesByName["AZAHAR"] = @"
    <emulator name="AZAHAR">
        <rule type="staticpath">
            <entry>$azaharExe</entry>
        </rule>
    </emulator>
"@
    }
}

if ($selectedIds -contains "kemulator") {
    $kemulatorBat = Join-Path $EmulatorsDir "KEmulator\KEmulator.bat"
    if (Test-Path $kemulatorBat) {
        $overridesByName["KEMULATOR"] = @"
    <emulator name="KEMULATOR">
        <rule type="staticpath">
            <entry>$kemulatorBat</entry>
        </rule>
    </emulator>
"@
    }
}

if ($overridesByName.Count -gt 0) {
    New-Item -ItemType Directory -Path $customDir -Force | Out-Null
    $xml = "<?xml version=`"1.0`"?>`n<!-- LumaArcade overrides -- see install-emulators.ps1 for why each one is here. -->`n<ruleList>`n" + (($overridesByName.Values) -join "`n") + "`n</ruleList>`n"
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($findRulesPath, $xml, $utf8NoBom)
    Write-Host "Wrote find-rule overrides to $findRulesPath"
}

# Most of these emulators write their own config/save files right next to
# their own .exe (portable mode) — fine normally, but $EmulatorsDir usually
# ends up under "C:\Program Files\ES-DE\Emulators\..." since that's where
# ES-DE itself is installed, and Windows blocks non-elevated processes from
# writing there at all. Confirmed live: melonDS failed outright with
# "Unable to write to config" the first time a game was launched. Games
# launched by Sunshine run as the interactive user, not elevated, so
# without this every standalone emulator here would hit the same wall the
# moment it tried to save settings or a save file.
Write-Step "Granting write access to $EmulatorsDir"
& icacls $EmulatorsDir /grant "Users:(OI)(CI)M" /T /Q | Out-Null

