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

        # Flatten one level of nesting if the exe isn't where expected but
        # is one folder down (e.g. archive contains a single top folder).
        if (-not (Test-Path (Join-Path $dest $ExpectedExe))) {
            $inner = Get-ChildItem $dest -Directory | Select-Object -First 1
            if ($inner -and (Test-Path (Join-Path $inner.FullName $ExpectedExe))) {
                Get-ChildItem $inner.FullName | Move-Item -Destination $dest -Force
                Remove-Item $inner.FullName -Recurse -Force -ErrorAction SilentlyContinue
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
}

# id -> [ { esdeSystem, label } ]. Only systems where es_systems.xml's
# *first*-listed (default) command is a RetroArch core rather than the
# standalone emulator this script installs — verified per-system against
# ES-DE's actual es_systems.xml this session, not guessed. Left out
# deliberately: cemu (wiiu), xenia (xbox360), switch (eden) already default
# to their standalone command since no RetroArch alternative exists for
# those systems; rpcs3 (ps3) and shadps4 (ps4) also have no RetroArch
# alternative, but their *own* default command expects a specific ROM
# format (shortcut/script files) that depends on how the user's actual
# dumps are structured -- not something to override blindly.
$DefaultEmulatorTargets = @{
    "3ds"         = @(@{ esdeSystem = "n3ds"; label = "Azahar (Standalone)" })
    "duckstation" = @(@{ esdeSystem = "psx"; label = "DuckStation (Standalone)" })
    "melonds"     = @(@{ esdeSystem = "nds"; label = "melonDS (Standalone)" })
    "pcsx2"       = @(@{ esdeSystem = "ps2"; label = "PCSX2 (Standalone)" })
    "ppsspp"      = @(@{ esdeSystem = "psp"; label = "PPSSPP (Standalone)" })
    "dolphin"     = @(
        @{ esdeSystem = "gc"; label = "Dolphin (Standalone)" },
        @{ esdeSystem = "wii"; label = "Dolphin (Standalone)" }
    )
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

$selectedIds = $Selected.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($selectedIds -contains "all") {
    $selectedIds = $Emulators.Keys + @("retroarch", "dolphin")
}

foreach ($id in $selectedIds) {
    if ($id -eq "retroarch") {
        Install-RetroArch
        continue
    }
    if ($id -eq "dolphin") {
        Install-Dolphin
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
}

# ES-DE's bundled es_find_rules.xml looks for the 3DS emulator's staticpath
# as ".../Citra/nightly-mingw/citra-qt.exe" specifically — but Citra is
# dead and its actively-maintained fork Azahar (staged above at that exact
# folder) names its executable "azahar.exe" instead, so the bundled rule
# won't match it. ES-DE supports overriding/extending emulator rules via a
# user-writable custom_systems/es_find_rules.xml — this adds a CITRA rule
# there pointing at the real azahar.exe path. Best-effort: the precise
# override-merge behavior wasn't verified against a real ES-DE run, only
# against its documented file-location convention.
if ($selectedIds -contains "3ds") {
    $customDir = Join-Path $env:USERPROFILE "ES-DE\custom_systems"
    New-Item -ItemType Directory -Path $customDir -Force | Out-Null
    $findRulesPath = Join-Path $customDir "es_find_rules.xml"
    $azaharExe = Join-Path $EmulatorsDir "Citra\nightly-mingw\azahar.exe"
    if (Test-Path $azaharExe) {
        $xml = @"
<?xml version="1.0"?>
<!-- LumaArcade override: Citra is dead, this repoints the 3DS emulator
     rule at Azahar (its actively-maintained fork) which we staged in
     Citra's expected folder but with its own executable name. -->
<ruleList>
    <emulator name="CITRA">
        <rule type="staticpath">
            <entry>$azaharExe</entry>
        </rule>
    </emulator>
</ruleList>
"@
        $utf8NoBom = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($findRulesPath, $xml, $utf8NoBom)
        Write-Host "Wrote Azahar find-rule override to $findRulesPath"
    }
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

