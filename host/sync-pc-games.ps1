<#
  Puts this PC's installed Steam and Epic games in ES-DE, with their names
  and (for Steam) their artwork, so they can be played from a browser like
  any other game - and picked for a guest link that opens straight into one.

    Steam  every library in libraryfolders.vdf: ROMs\steam\<name>.url
           (steam://rungameid/<id>), Steam's cover, hero and logo as ES-DE
           media where ES-DE has none.
    Epic   the launcher's install manifests: ROMs\epic\<name>.url
           (com.epicgames.launcher://apps/...). DLC and add-ons are skipped.

  Shortcuts for games that were uninstalled are moved to ROMs\..\_removed.
  Only shortcuts this script makes (steam:// and Epic launcher links) are
  ever touched; anything else in those folders is left alone.

  Runs as the games account (scheduled task \LumaArcade\PC Games, at sign-in
  and early each morning, or "Import now" in Host health). ES-DE rewrites
  its game lists when it closes, so:
    - nothing new or gone: stop;
    - someone streaming: stop, the next run tries again;
    - ES-DE open: close it the normal way (it saves its lists), sync, and
      leave it closed - the next stream starts it again.
  Result: C:\ProgramData\LumaArcade\home\pc-games.json (Host health shows it)
  Log:    C:\ProgramData\LumaArcade\home\pc-games.log

  -Check   only say what would change
  -Force   sync even when nothing changed (refreshes names and artwork)
#>
param([switch]$Check, [switch]$Force)
$ErrorActionPreference = 'Stop'
$dataDir = $PSScriptRoot
$homeDir = Join-Path $dataDir 'home'
$statusFile = Join-Path $homeDir 'pc-games.json'
$logFile = Join-Path $homeDir 'pc-games.log'
New-Item -ItemType Directory -Force $homeDir | Out-Null
function Log($m) { Add-Content $logFile "$(Get-Date -Format s) $m" }
function SaveStatus($s) { $s | ConvertTo-Json -Depth 4 | Set-Content $statusFile -Encoding UTF8 }

# Steam tools, servers and runtimes aren't games.
$skipSteam = 'Dedicated Server|Redistributable|Steamworks|Proton|Steam Linux Runtime|SDK|Soundtrack|Wallpaper Engine|SteamVR'
$skipSteamIds = @('228980', '1070560', '1391110', '1628350', '250820')

function SafeName([string]$name) { (($name -replace '[\\/:*?"<>|]', '_') -replace '[^\u0020-\uFFFF]', '').Trim() }

# --- where ES-DE keeps things (host.json from Setup, ES-DE's own settings)

function Get-EsDe {
    $config = Get-Content (Join-Path $dataDir 'host.json') -Raw | ConvertFrom-Json
    if (-not $config.esDeDir -or -not $config.gamelists) { throw 'host.json has no ES-DE folder - run Setup again' }
    $esData = Split-Path $config.gamelists
    $settings = @{}
    $file = Join-Path $esData 'settings\es_settings.xml'
    if (Test-Path $file) {
        foreach ($m in [regex]::Matches((Get-Content $file -Raw), '<string name="(\w+)" value="([^"]*)"')) { $settings[$m.Groups[1].Value] = $m.Groups[2].Value }
    }
    $expand = { param($p) if ($p) { $p.Replace('%ESPATH%', $config.esDeDir).Replace('~', $env:USERPROFILE) } }
    $roms = & $expand $settings['ROMDirectory']
    if (-not $roms) { $roms = Join-Path $config.esDeDir 'ROMs' }
    $media = & $expand $settings['MediaDirectory']
    if (-not $media) { $media = Join-Path $esData 'downloaded_media' }
    [pscustomobject]@{ Roms = $roms; Media = $media; Gamelists = $config.gamelists }
}

# --- what's installed

function Get-SteamGames {
    $steam = $null
    foreach ($key in 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam', 'HKLM:\SOFTWARE\Valve\Steam') {
        $p = (Get-ItemProperty $key -ErrorAction SilentlyContinue).InstallPath
        if ($p -and (Test-Path $p)) { $steam = $p; break }
    }
    if (-not $steam) { $p = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction SilentlyContinue).SteamPath; if ($p -and (Test-Path $p)) { $steam = $p } }
    if (-not $steam) { return @() }
    $libraries = @(Join-Path $steam 'steamapps')
    $vdf = Join-Path $steam 'steamapps\libraryfolders.vdf'
    if (Test-Path $vdf) {
        foreach ($m in [regex]::Matches((Get-Content $vdf -Raw), '"path"\s+"([^"]+)"')) { $libraries += Join-Path ($m.Groups[1].Value -replace '\\\\', '\') 'steamapps' }
    }
    $seen = @{}
    foreach ($lib in $libraries | Select-Object -Unique) {
        if (-not (Test-Path $lib)) { continue }
        foreach ($m in Get-ChildItem $lib -Filter appmanifest_*.acf -ErrorAction SilentlyContinue) {
            $t = Get-Content $m.FullName -Raw
            $id = [regex]::Match($t, '"appid"\s+"(\d+)"').Groups[1].Value
            $name = [regex]::Match($t, '"name"\s+"([^"]+)"').Groups[1].Value
            if (-not $id -or -not $name -or $seen[$id] -or $name -match $skipSteam -or $skipSteamIds -contains $id) { continue }
            $seen[$id] = $true
            [pscustomobject]@{ System = 'steam'; Id = $id; Name = $name; File = "$(SafeName $name).url"; Url = "steam://rungameid/$id"; Art = Join-Path $steam "appcache\librarycache\$id" }
        }
    }
}

function Get-EpicGames {
    $dir = Join-Path $env:ProgramData 'Epic\EpicGamesLauncher\Data\Manifests'
    if (-not (Test-Path $dir)) { return @() }
    foreach ($f in Get-ChildItem $dir -Filter *.item) {
        try { $m = Get-Content $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
        $cats = @($m.AppCategories)
        if ($m.bIsIncompleteInstall -or $cats -contains 'hidden' -or $cats -notcontains 'games') { continue }
        # DLC points at its game.
        if ($m.MainGameAppName -and $m.MainGameAppName -ne $m.AppName) { continue }
        $launch = "com.epicgames.launcher://apps/$($m.CatalogNamespace)%3A$($m.CatalogItemId)%3A$($m.AppName)?action=launch&silent=true"
        [pscustomobject]@{ System = 'epic'; Id = $m.AppName; Name = $m.DisplayName; File = "$(SafeName $m.DisplayName).url"; Url = $launch; Art = $null }
    }
}

# --- shortcuts already there (only the kinds this script makes)

function Get-Shortcuts($romDir, $system) {
    $folder = Join-Path $romDir $system
    if (-not (Test-Path $folder)) { return @() }
    foreach ($u in Get-ChildItem $folder -Filter *.url) {
        $url = (Get-Content $u.FullName | Where-Object { $_ -like 'URL=*' } | Select-Object -First 1) -replace '^URL=', ''
        if ($url -like 'steam://*' -or $url -like 'com.epicgames.launcher://*') { [pscustomobject]@{ System = $system; File = $u.Name; Path = $u.FullName; Url = $url } }
    }
}

# --- writing

function Add-ToGamelist($gamelists, $system, $entries) {
    $file = Join-Path $gamelists "$system\gamelist.xml"
    New-Item -ItemType Directory -Force (Split-Path $file) | Out-Null
    if (Test-Path $file) { [xml]$xml = Get-Content $file -Raw -Encoding UTF8 } else { [xml]$xml = '<?xml version="1.0"?><gameList />' }
    if (-not $xml.gameList) { [void]$xml.AppendChild($xml.CreateElement('gameList')) }
    $root = $xml.SelectSingleNode('/gameList')
    $changed = $false
    foreach ($g in $entries) {
        $rel = "./$($g.File)"
        if ($root.SelectNodes('game') | Where-Object { $_.path -eq $rel }) { continue }
        $entry = $xml.CreateElement('game')
        $p = $xml.CreateElement('path'); $p.InnerText = $rel; [void]$entry.AppendChild($p)
        $n = $xml.CreateElement('name'); $n.InnerText = $g.Name; [void]$entry.AppendChild($n)
        [void]$root.AppendChild($entry)
        $changed = $true
    }
    if (-not $changed) { return }
    $settings = New-Object System.Xml.XmlWriterSettings
    $settings.Indent = $true; $settings.IndentChars = "`t"; $settings.Encoding = New-Object System.Text.UTF8Encoding $false
    $w = [System.Xml.XmlWriter]::Create($file, $settings); $xml.Save($w); $w.Close()
}

function Copy-SteamArt($game, $mediaDir) {
    if (-not $game.Art -or -not (Test-Path $game.Art)) { return }
    $base = [IO.Path]::GetFileNameWithoutExtension($game.File)
    $art = @{ 'library_600x900.jpg' = 'covers'; 'library_hero.jpg' = 'fanart'; 'logo.png' = 'marquees' }
    foreach ($source in $art.Keys) {
        $target = Join-Path $mediaDir "steam\$($art[$source])"
        if (Get-ChildItem $target -Filter "$base.*" -ErrorAction SilentlyContinue) { continue }
        $src = Get-ChildItem $game.Art -Recurse -Filter $source -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 1
        if (-not $src) { continue }
        New-Item -ItemType Directory -Force $target | Out-Null
        Copy-Item $src.FullName (Join-Path $target "$base$($src.Extension)")
    }
}

# --- the run

try {
    $es = Get-EsDe
    $installed = @(Get-SteamGames) + @(Get-EpicGames)
    $existing = @(Get-Shortcuts $es.Roms 'steam') + @(Get-Shortcuts $es.Roms 'epic')
    # An Epic game already linked from the Steam folder (set up by hand) counts as there.
    $haveUrl = @{}; foreach ($s in $existing) { $haveUrl[$s.Url] = $true }
    $haveEpic = @{}; foreach ($s in $existing | Where-Object { $_.Url -like 'com.epicgames.launcher://*' }) { if ($s.Url -match '%3A([^?%]+)\?') { $haveEpic[$Matches[1]] = $true } }
    $new = @($installed | Where-Object { -not ($haveUrl[$_.Url] -or ($_.System -eq 'epic' -and $haveEpic[$_.Id])) })
    $wantedUrls = @{}; foreach ($g in $installed) { $wantedUrls[$g.Url] = $true }
    $wantedEpic = @{}; foreach ($g in $installed | Where-Object System -eq 'epic') { $wantedEpic[$g.Id] = $true }
    $gone = @($existing | Where-Object {
        if ($_.Url -like 'steam://*') { -not $wantedUrls[$_.Url] }
        elseif ($_.Url -match '%3A([^?%]+)\?') { -not $wantedEpic[$Matches[1]] }
        else { $false }
    })
    $counts = @{ steam = @($installed | Where-Object System -eq 'steam').Count; epic = @($installed | Where-Object System -eq 'epic').Count }

    if ($Check) {
        "Steam: $($counts.steam) installed, Epic: $($counts.epic) installed"
        $new | ForEach-Object { "would add: $($_.Name) ($($_.System))" }
        $gone | ForEach-Object { "would move out: $($_.File) ($($_.System))" }
        exit 0
    }
    if (-not $new.Count -and -not $gone.Count -and -not $Force) {
        SaveStatus @{ at = (Get-Date).ToString('o'); steam = $counts.steam; epic = $counts.epic; added = @(); removed = @(); waiting = $null }
        exit 0
    }
    if (Get-Process streamer -ErrorAction SilentlyContinue) {
        $why = "someone is streaming; trying again later ($($new.Count) new, $($gone.Count) gone)"
        Log $why
        SaveStatus @{ at = (Get-Date).ToString('o'); steam = $counts.steam; epic = $counts.epic; added = @(); removed = @(); waiting = $why }
        exit 0
    }
    $running = Get-Process ES-DE -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($running) {
        [void]$running.CloseMainWindow()
        if (-not $running.WaitForExit(30000)) { Log "ES-DE didn't close; trying again later"; exit 0 }
        Log 'closed ES-DE for the sync'
    }

    foreach ($g in $(if ($Force) { $installed } else { $new })) {
        $folder = Join-Path $es.Roms $g.System
        New-Item -ItemType Directory -Force $folder | Out-Null
        $file = Join-Path $folder $g.File
        if (-not (Test-Path $file)) { Set-Content $file "[InternetShortcut]`r`nURL=$($g.Url)" -Encoding ASCII }
        if ($g.System -eq 'steam') { Copy-SteamArt $g $es.Media }
    }
    foreach ($system in 'steam', 'epic') {
        $entries = @($installed | Where-Object { $_.System -eq $system -and (Test-Path (Join-Path $es.Roms "$system\$($_.File)")) })
        if ($entries.Count) { Add-ToGamelist $es.Gamelists $system $entries }
    }
    $removedDir = Join-Path (Split-Path $es.Roms) '_removed'
    foreach ($s in $gone) {
        $to = Join-Path $removedDir $s.System
        New-Item -ItemType Directory -Force $to | Out-Null
        Move-Item $s.Path (Join-Path $to $s.File) -Force
    }
    $added = @($new | ForEach-Object { $_.Name })
    $removed = @($gone | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension($_.File) })
    Log "synced: $($added.Count) new ($($added -join ', ')), $($removed.Count) gone ($($removed -join ', '))"
    SaveStatus @{ at = (Get-Date).ToString('o'); steam = $counts.steam; epic = $counts.epic; added = $added; removed = $removed; waiting = $null }
} catch {
    Log "failed: $($_.Exception.Message)"
    SaveStatus @{ at = (Get-Date).ToString('o'); error = $_.Exception.Message }
    exit 1
}
