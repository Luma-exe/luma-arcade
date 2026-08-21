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

# Downloads the first GitHub release asset matching $AssetPattern from
# $Repo's latest release and extracts it into $EmulatorsDir\$DestFolder,
# flattening one level of nesting if the archive wraps everything in a
# single subfolder (common — moonlight-web-stream's release did the same).
function Install-GithubEmulator($Name, $Repo, $AssetPattern, $DestFolder, $ExpectedExe) {
    Write-Step $Name
    $dest = Join-Path $EmulatorsDir $DestFolder
    if (Test-Path (Join-Path $dest $ExpectedExe)) {
        Write-Host "$Name already staged, skipping."
        return
    }
    try {
        $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
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

# id -> { repo, pattern, folder, exe }. Folder/exe values match ES-DE's
# actual bundled es_find_rules.xml staticpath entries — verified against
# its GitLab source this session, not guessed.
$Emulators = @{
    "cemu"        = @{ repo = "cemu-project/Cemu"; pattern = "cemu-*-windows-x64.zip"; folder = "cemu"; exe = "Cemu.exe" }
    "3ds"         = @{ repo = "azahar-emu/azahar"; pattern = "azahar-windows-msvc-*.zip"; folder = "Citra\nightly-mingw"; exe = "azahar.exe" }
    "duckstation" = @{ repo = "stenzek/duckstation"; pattern = "duckstation-windows-x64-release.zip"; folder = "duckstation"; exe = "duckstation-qt-x64-ReleaseLTCG.exe" }
    "melonds"     = @{ repo = "melonDS-emu/melonDS"; pattern = "melonDS-*-windows-x86_64.zip"; folder = "melonDS"; exe = "melonDS.exe" }
    "pcsx2"       = @{ repo = "PCSX2/pcsx2"; pattern = "pcsx2-*-windows-x64-Qt.7z"; folder = "PCSX2-Qt"; exe = "pcsx2-qt.exe" }
    "ppsspp"      = @{ repo = "hrydgard/ppsspp"; pattern = "PPSSPP-*-Windows-x64.zip"; folder = "PPSSPP"; exe = "PPSSPPWindows64.exe" }
    "rpcs3"       = @{ repo = "RPCS3/rpcs3-binaries-win"; pattern = "rpcs3-*win64_msvc.7z"; folder = "RPCS3"; exe = "rpcs3.exe" }
    "shadps4"     = @{ repo = "shadps4-emu/shadPS4"; pattern = "shadps4-win64-sdl-*.zip"; folder = "shadPS4"; exe = "shadPS4.exe" }
    "vita3k"      = @{ repo = "Vita3K/Vita3K"; pattern = "windows-latest.zip"; folder = "Vita3K"; exe = "Vita3K.exe" }
    "xemu"        = @{ repo = "xemu-project/xemu"; pattern = "xemu-*-windows-x86_64.zip"; folder = "xemu"; exe = "xemu.exe" }
    "xenia"       = @{ repo = "xenia-canary/xenia-canary-releases"; pattern = "xenia_canary_windows_.zip"; folder = "xenia_canary"; exe = "xenia_canary.exe" }
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

$selectedIds = $Selected.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($selectedIds -contains "all") {
    $selectedIds = $Emulators.Keys + @("retroarch")
}

foreach ($id in $selectedIds) {
    if ($id -eq "retroarch") {
        Install-RetroArch
        continue
    }
    $e = $Emulators[$id]
    if (-not $e) {
        Write-Host "Unknown emulator id '$id', skipping."
        continue
    }
    Install-GithubEmulator -Name $id -Repo $e.repo -AssetPattern $e.pattern -DestFolder $e.folder -ExpectedExe $e.exe
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

Write-Host ""
Write-Host "=== Not auto-installed (no reliable scripted source found) ==="
Write-Host "GameCube/Wii (Dolphin): dolphin-emu.org is behind an anti-bot challenge that blocks scripted downloads. Get it manually from https://dolphin-emu.org/download/ and place Dolphin.exe at $EmulatorsDir\Dolphin-x64\Dolphin.exe"
Write-Host "Switch: both Yuzu and its earlier successors (Suyu, Sudachi) have been shut down by Nintendo takedowns, and the current 2026 successor (Eden) has moved off GitHub specifically to evade further ones. This project doesn't want to hardcode a download source for that -- get a current build yourself and add a custom es_find_rules.xml entry pointing at it (see ES-DE's INSTALL.md)."
