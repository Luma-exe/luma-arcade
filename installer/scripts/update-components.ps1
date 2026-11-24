# The Updates window's helper (run by the Luma Arcade server, see
# server/src/updates): what Setup installed on this PC, which of it has a
# newer version, and updating it in place. Settings and saves stay: an
# update unpacks over the program's folder like Setup's Repair does.
#
#   update-components.ps1 -Action list                     installed things and their versions (no network)
#   update-components.ps1 -Action check [-Newest]          plus the version each would update to
#   update-components.ps1 -Action update -Only a,b [-Newest] -StatusFile <json>
#
# "Tested" versions come from versions.json on GitHub's main branch (the
# list Setup uses, kept current by the "Tested versions" workflow), or this
# copy's when GitHub can't be reached; -Newest takes each one's newest
# release. list and check print one JSON object. update writes its progress
# to -StatusFile as it goes; things that need an administrator (Sunshine,
# the tunnel, drivers, Luma Arcade itself) ask Windows for permission once.
param(
    [ValidateSet('list', 'check', 'update')] [string]$Action = 'list',
    [string]$Only = '',
    [switch]$Newest,
    [string]$GamesDir = '',
    [string]$StatusFile = '',
    [switch]$Elevated
)
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'catalog.ps1')
$script:DownloadDir = Join-Path $env:TEMP 'LumaArcadeUpdates'
$script:WarningsFile = Join-Path $script:DownloadDir 'warnings.txt'
$LumaRepo = 'Luma-exe/luma-arcade'
$TestedUrl = "https://raw.githubusercontent.com/$LumaRepo/main/installer/scripts/versions.json"
$UninstallKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\LumaArcade'

function Test-Admin {
    ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# --- where things are

function Find-EsDeDir {
    if ($GamesDir -and (Test-Path (Join-Path $GamesDir 'ES-DE\ES-DE.exe'))) { return Join-Path $GamesDir 'ES-DE' }
    $fromSetup = (Get-ItemProperty 'HKLM:\SOFTWARE\LumaArcade' -ErrorAction SilentlyContinue).GamesDir
    if ($fromSetup -and (Test-Path (Join-Path $fromSetup 'ES-DE\ES-DE.exe'))) { return Join-Path $fromSetup 'ES-DE' }
    # host.json (a PC set up by hand) names the emulators folder, ES-DE's Emulators.
    try {
        $hostFile = Join-Path $env:ProgramData 'LumaArcade\host.json'
        $emu = if (Test-Path $hostFile) { (Get-Content -Raw $hostFile | ConvertFrom-Json).emulators }
        if ($emu -and (Test-Path (Join-Path (Split-Path $emu) 'ES-DE.exe'))) { return Split-Path $emu }
    } catch { }
    foreach ($drive in Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue) {
        foreach ($dir in "$($drive.Root)ES-DE", "$($drive.Root)Games\ES-DE") {
            if (Test-Path (Join-Path $dir 'ES-DE.exe')) { return $dir }
        }
    }
    $null
}
function Find-EmulatorRoot($EsDeDir) {
    if ($EsDeDir) { return Join-Path $EsDeDir 'Emulators' }
    $fromSetup = if ($GamesDir) { $GamesDir } else { (Get-ItemProperty 'HKLM:\SOFTWARE\LumaArcade' -ErrorAction SilentlyContinue).GamesDir }
    if ($fromSetup) { return Join-Path $fromSetup 'Emulators' }
    $null
}

function Get-UninstallEntry([string]$NamePattern) {
    Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -match $NamePattern } | Select-Object -First 1
}

function Get-ExeVersion($File) {
    if (-not $File) { return $null }
    $info = (Get-Item -LiteralPath $File).VersionInfo
    foreach ($v in $info.ProductVersion, $info.FileVersion) { if ($v -and $v.Trim() -and $v -notmatch '^[0, .]+$') { return ($v.Trim() -replace ',\s*', '.') } }
    $null
}

# Running programs inside $Dir (a game, or ES-DE itself): updating would
# fail on locked files, or pull the floor out from under a player.
function Get-BusyIn([string]$Dir) {
    if (-not $Dir) { return @() }
    $prefix = $Dir.TrimEnd('\') + '\'
    @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } |
        Select-Object -ExpandProperty ProcessName -Unique)
}

# --- versions

# 'same', 'older' (an update), 'newer' or 'unknown'.
function Compare-Installed([string]$Installed, [string]$Target, $InstalledDate) {
    if (-not $Installed -or -not $Target) { return 'unknown' }
    $norm = { param($v) ($v.Trim() -replace '^(v\.?|build-)', '').ToLowerInvariant() }
    $a = & $norm $Installed; $b = & $norm $Target
    if ($a -eq $b) { return 'same' }
    # Rolling releases ("latest 2026-09-12"): by date.
    if ($Target -match '(\d{4}-\d{2}-\d{2})') {
        $targetDate = [datetime]$Matches[1]
        $have = if ($Installed -match '(\d{4}-\d{2}-\d{2})') { [datetime]$Matches[1] } else { $InstalledDate }
        if (-not $have) { return 'unknown' }
        if ($have.Date -ge $targetDate.Date) { return 'same' } else { return 'older' }
    }
    $parts = {
        param($v)
        if ($v -notmatch '^(\d+(?:\.\d+)*)(?:[-+ ].*)?$') { return $null }
        $p = [Collections.Generic.List[long]]@($Matches[1].Split('.') | ForEach-Object { [long]$_ })
        while ($p.Count -gt 1 -and $p[$p.Count - 1] -eq 0) { $p.RemoveAt($p.Count - 1) }
        , $p
    }
    $x = & $parts $a; $y = & $parts $b
    if (-not $x -or -not $y) { return 'unknown' }
    for ($i = 0; $i -lt [Math]::Max($x.Count, $y.Count); $i++) {
        $xi = if ($i -lt $x.Count) { $x[$i] } else { 0 }
        $yi = if ($i -lt $y.Count) { $y[$i] } else { 0 }
        if ($xi -lt $yi) { return 'older' }
        if ($xi -gt $yi) { return 'newer' }
    }
    'same'
}

# --- what's installed

function Get-Components {
    $recorded = Get-InstalledVersions
    $esde = Find-EsDeDir
    $emuRoot = Find-EmulatorRoot $esde
    $list = [Collections.Generic.List[object]]::new()
    function Add-Component($Id, $Name, $What, $Group, $Version, $Dir, $Date, [switch]$Admin, $Note = $null) {
        $rec = $recorded.$Id
        $list.Add([ordered]@{
            id = $Id; name = $Name; what = $What; group = $Group; admin = [bool]$Admin
            installed = if ($rec) { $rec.version } else { $Version }
            versionFrom = if ($rec) { 'recorded' } elseif ($Version) { 'program' } else { 'unknown' }
            date = if ($Date) { $Date.ToString('yyyy-MM-dd') } else { $null }
            dir = $Dir; note = $Note
            busy = @(Get-BusyIn $Dir)
        })
    }

    $sun = Get-UninstallEntry '^Sunshine'
    if ($sun) { Add-Component 'sunshine' 'Sunshine' 'Captures and sends the screen' 'Streaming' $sun.DisplayVersion $null $null -Admin -Note 'Ends any stream in progress' }
    $tunnel = Get-CimInstance Win32_Service -Filter "Name='Cloudflared'" -ErrorAction SilentlyContinue
    if ($tunnel) {
        $exe = ($tunnel.PathName -replace '^"([^"]+)".*', '$1' -replace '^(\S+\.exe).*', '$1')
        $ver = $null
        if (Test-Path $exe) { $ver = ((& $exe --version 2>$null) -join ' ') -replace '.*version\s+(\S+).*', '$1' }
        if (-not $ver) { $ver = (Get-UninstallEntry '^cloudflared').DisplayVersion }
        Add-Component 'cloudflared' 'Cloudflare Tunnel' 'Lets friends outside your house in' 'Streaming' $ver $null $null -Admin -Note 'Guests outside reconnect'
    }
    if (Get-CimInstance Win32_PnPEntity -Filter "PNPDeviceID LIKE 'ROOT\\DISPLAY\\%'" -ErrorAction SilentlyContinue | Where-Object { $_.HardwareID -contains 'Root\MttVDD' }) {
        Add-Component 'vdd' 'Virtual Display Driver' 'The screen Sunshine streams' 'Streaming' $null $null $null -Admin -Note 'The screen blinks once'
    }
    $vigem = Get-UninstallEntry '^ViGEm Bus'
    if ($vigem) { Add-Component 'vigembus' 'ViGEmBus' "Players' controllers on this PC" 'Streaming' $vigem.DisplayVersion $null $null -Admin }

    if ($esde) {
        $exe = Join-Path $esde 'ES-DE.exe'
        Add-Component 'esde' 'ES-DE' 'The menu you pick games from' 'Game library' (Get-ExeVersion $exe) $esde (Get-Item $exe).LastWriteTime
        # ES-DE's own folder holds the emulators too: only ES-DE itself counts.
        $list[$list.Count - 1].busy = @(Get-BusyIn $esde | Where-Object { $_ -eq 'ES-DE' })
        $theme = Join-Path $esde 'themes\iconic-es-de'
        if (Test-Path (Join-Path $theme 'theme.xml')) { Add-Component 'iconic' 'Iconic theme' "ES-DE's look" 'Game library' $null $theme $null }
        $list[$list.Count - 1].busy = @()
    }
    if ($emuRoot) {
        foreach ($key in $Catalog.Keys) {
            $entry = $Catalog[$key]
            $dir = Join-Path $emuRoot $entry.Folder
            $exe = Get-ChildItem -Path $dir -Filter $entry.Exe -File -Recurse -Depth 1 -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $exe) { continue }
            $what = if ($entry.Name -match '\((.+)\)$') { $Matches[1] } else { '' }
            $name = $entry.Name -replace '\s*\(.*$', ''
            Add-Component $key $name $what 'Emulators' (Get-ExeVersion $exe.FullName) $dir $exe.LastWriteTime
        }
    }
    , $list
}

# The tested list: GitHub's current one, else this copy's.
function Use-TestedList {
    try {
        New-Item -ItemType Directory -Force $script:DownloadDir | Out-Null
        $file = Join-Path $script:DownloadDir 'versions.json'
        Invoke-WebRequest -Uri $TestedUrl -OutFile $file -UseBasicParsing -Headers $script:UserAgent -TimeoutSec 15
        [void](Get-Content -Raw $file | ConvertFrom-Json).downloads
        $script:VersionsFile = $file
        $script:Pinned = $null
        return 'github'
    } catch { return 'local' }
}

function Get-LumaRelease {
    $release = Invoke-RestMethod "https://api.github.com/repos/$LumaRepo/releases/latest" -Headers (Get-GitHubApiHeaders) -TimeoutSec 20
    $asset = $release.assets | Where-Object name -eq 'LumaArcadeSetup.exe' | Select-Object -First 1
    if (-not $asset) { throw "Release $($release.tag_name) has no LumaArcadeSetup.exe" }
    $sums = $release.assets | Where-Object name -eq 'SHA256SUMS.txt' | Select-Object -First 1
    [pscustomobject]@{ Version = $release.tag_name.TrimStart('v'); Url = $asset.browser_download_url; Name = $asset.name; SumsUrl = $sums.browser_download_url; Notes = $release.html_url }
}

# The version an update would install, and where it comes from.
function Get-Target([string]$Id) {
    $entry = Get-CatalogEntry $Id
    $src = Get-CatalogDownload $Id -Latest:$Newest
    $notes = if ($entry.Repo) { "https://github.com/$($entry.Repo)/releases" } elseif ($Id -eq 'esde') { 'https://gitlab.com/es-de/emulationstation-de/-/releases' } else { $null }
    [pscustomobject]@{ Version = $src.Version; Source = $src; Notes = $notes }
}

function Invoke-Check($Components) {
    $from = if ($Newest) { 'newest' } else { Use-TestedList }
    foreach ($c in $Components) {
        try {
            $t = Get-Target $c.id
            $c.target = [string]$t.Version
            $c.notes = $t.Notes
            $date = if ($c.date) { [datetime]$c.date } else { $null }
            $c.compare = Compare-Installed $c.installed $c.target $date
        } catch {
            $c.error = $_.Exception.Message
        }
    }
    $from
}

# --- updating

$script:Status = [ordered]@{ running = $true; started = (Get-Date).ToString('s'); items = [ordered]@{}; log = [Collections.Generic.List[string]]::new() }
function Write-Status {
    if (-not $StatusFile) { return }
    $tmp = "$StatusFile.tmp"
    $script:Status | ConvertTo-Json -Depth 5 | Set-Content -Path $tmp -Encoding UTF8
    Move-Item -Force $tmp $StatusFile
}
function Set-UpdateState([string]$Id, [string]$State, [string]$Phase = '', [string]$Message = '', [string]$Version = '') {
    $script:Status.items[$Id] = [ordered]@{ state = $State; phase = $Phase; message = $Message; version = $Version }
    $line = "$(Get-Date -Format HH:mm:ss) $Id $State $Phase $Message".Trim()
    $script:Status.log.Add($line)
    Write-Status
}

function Update-Luma {
    $key = Get-ItemProperty $UninstallKey -ErrorAction SilentlyContinue
    if (-not $key -or -not $key.InstallLocation -or -not (Test-Path (Join-Path $key.InstallLocation 'server\dist\main.js'))) {
        throw "This copy of Luma Arcade wasn't installed by Setup, so there's nothing to upgrade in place"
    }
    Set-UpdateState 'luma' 'updating' 'Downloading'
    $rel = Get-LumaRelease
    $file = Save-Download $rel $null
    if ($rel.SumsUrl) {
        Set-UpdateState 'luma' 'updating' 'Checking file'
        $sums = (Invoke-WebRequest -Uri $rel.SumsUrl -UseBasicParsing -Headers $script:UserAgent).Content
        $want = ([regex]::Match($sums, '(?im)^([0-9a-f]{64})\s+\*?LumaArcadeSetup\.exe\s*$')).Groups[1].Value
        if (-not $want) { throw "SHA256SUMS.txt doesn't list LumaArcadeSetup.exe" }
        if ((Get-FileHash -Algorithm SHA256 $file).Hash -ne $want.ToUpperInvariant()) { Remove-Item -Force $file; throw "LumaArcadeSetup.exe doesn't match its checksum - not running it" }
    }
    # Setup stops Luma Arcade (and this window's server with it), upgrades
    # with the same choices as last time, and starts it again. Nothing to wait for here.
    Set-UpdateState 'luma' 'restarting' 'Installing' 'Luma Arcade restarts; this window reconnects by itself' $rel.Version
    Start-Process -FilePath $file -ArgumentList '/S', '/EMULATORS=none'
}

function Update-One([string]$Id, $Component) {
    if ($Id -eq 'luma') { Update-Luma; return }
    if ($Component.busy.Count) { throw "Close $($Component.busy -join ', ') first" }
    $entry = Get-CatalogEntry $Id
    Set-UpdateState $Id 'updating' 'Downloading'
    $src = Get-CatalogDownload $Id -Latest:$Newest
    $file = Save-CatalogDownload $Id $src
    Set-UpdateState $Id 'updating' 'Installing'
    switch ($Id) {
        'sunshine' {
            $p = Start-Process msiexec.exe -ArgumentList '/i', "`"$file`"", '/qn', '/norestart' -Wait -PassThru
            Remove-Item -Force $file
            if ($p.ExitCode -notin 0, 3010) { throw "Sunshine's installer failed (exit code $($p.ExitCode))" }
            Start-Service SunshineService -ErrorAction SilentlyContinue
        }
        'cloudflared' {
            $svc = Get-CimInstance Win32_Service -Filter "Name='Cloudflared'"
            $exe = ($svc.PathName -replace '^"([^"]+)".*', '$1' -replace '^(\S+\.exe).*', '$1')
            Stop-Service Cloudflared -Force
            try { Copy-Item -Force $file $exe } finally { Start-Service Cloudflared }
            Remove-Item -Force $file
        }
        'vigembus' {
            $p = Start-Process -FilePath $file -ArgumentList '/exenoui', '/qn', '/norestart' -Wait -PassThru
            Remove-Item -Force $file
            # 3010 = done, restart needed; 1638 = this version or newer is already there.
            if ($p.ExitCode -notin 0, 3010, 1638) { throw "ViGEmBus's installer failed (exit code $($p.ExitCode))" }
        }
        'vdd' {
            $dir = Join-Path $script:DownloadDir 'vdd'
            if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
            Expand-Download $file $dir
            $inf = Get-ChildItem $dir -Recurse -Filter MttVDD.inf | Select-Object -First 1
            if (-not $inf) { throw 'MttVDD.inf is missing from the download' }
            $out = & "$env:SystemRoot\System32\pnputil.exe" /add-driver $inf.FullName /install
            if ($LASTEXITCODE -notin 0, 259, 3010) { throw "pnputil failed ($LASTEXITCODE): $($out -join ' ')" }
        }
        default {
            # ES-DE, its theme and the emulators: over their folder, like Repair.
            Expand-Download $file $Component.dir
            foreach ($f in @($entry.Portable)) { if ($f) { New-Item -ItemType File -Force (Join-Path $Component.dir $f) | Out-Null } }
            foreach ($d in @($entry.PortableDirs)) { if ($d) { New-Item -ItemType Directory -Force (Join-Path $Component.dir $d) | Out-Null } }
            if ($Id -eq 'retroarch') { Install-RetroArchCores $Component.dir -Latest:$Newest }
        }
    }
    Save-InstalledVersion $Id $src.Version
    Set-UpdateState $Id 'done' '' '' $src.Version
}

# --- main

if ($Action -in 'list', 'check') {
    $components = Get-Components
    $from = if ($Action -eq 'check') { Invoke-Check $components } else { $null }
    [ordered]@{ checkedAt = (Get-Date).ToString('s'); mode = $(if ($Newest) { 'newest' } else { 'tested' }); testedFrom = $from; isAdmin = (Test-Admin); components = $components } |
        ConvertTo-Json -Depth 6 -Compress
    exit 0
}

# update
$ids = @($Only -split '[,\s]+' | Where-Object { $_ })
if (-not $ids) { throw 'Nothing to update: give -Only' }
$all = Get-Components
$byId = @{}; foreach ($c in $all) { $byId[$c.id] = $c }
$needsAdmin = $ids | Where-Object { $_ -eq 'luma' -or ($byId[$_] -and $byId[$_].admin) }
if ($needsAdmin -and -not (Test-Admin) -and -not $Elevated) {
    # Ask Windows once, and do the whole lot as administrator.
    foreach ($id in $ids) { Set-UpdateState $id 'queued' 'Waiting for permission' }
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$PSCommandPath`"", '-Action', 'update', '-Only', ($ids -join ','), '-StatusFile', "`"$StatusFile`"", '-Elevated')
    if ($Newest) { $argList += '-Newest' }
    if ($GamesDir) { $argList += @('-GamesDir', "`"$GamesDir`"") }
    try {
        $p = Start-Process powershell.exe -Verb RunAs -ArgumentList $argList -WindowStyle Hidden -Wait -PassThru
        exit $p.ExitCode
    } catch {
        foreach ($id in $ids) { Set-UpdateState $id 'failed' '' "Windows asked for permission and it wasn't given" }
        $script:Status.running = $false; Write-Status
        exit 1
    }
}

if (-not $Newest) { [void](Use-TestedList) }
foreach ($id in $ids) { Set-UpdateState $id 'queued' 'Waiting' }
$failed = 0
foreach ($id in $ids) {
    try {
        if ($id -ne 'luma' -and -not $byId[$id]) { throw "$id isn't installed on this PC" }
        Update-One $id $byId[$id]
    } catch {
        $failed++
        Set-UpdateState $id 'failed' '' $_.Exception.Message
    }
}
$script:Status.running = $false
Write-Status
exit $(if ($failed) { 1 } else { 0 })
