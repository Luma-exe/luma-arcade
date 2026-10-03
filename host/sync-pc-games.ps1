<#
  Puts this PC's installed games in ES-DE, with their names and (for Steam)
  their artwork, so they can be played from a browser like any other game -
  and picked for a guest link that opens straight into one.

    Steam    every library in libraryfolders.vdf: ROMs\steam\<name>.url
             (steam://rungameid/<id>), Steam's cover, hero and logo as ES-DE
             media where ES-DE has none.
    Epic     the launcher's install manifests: ROMs\epic\<name>.url
             (com.epicgames.launcher://apps/...). DLC and add-ons are skipped.
    Others   ES-DE has no system for these, so they go in "Microsoft Windows"
             (ROMs\windows\<name>.lnk):
               Xbox app / Game Pass  games in the Xbox app's games folders
               EA app                games EA's installer registered
               GOG                   GOG Galaxy and offline GOG installs
               Ubisoft Connect       uplay://launch/<id>/0
    Luma Arcade on GitHub  added to "Microsoft Windows" once; delete it and
             it stays gone.

  Shortcuts for games that were uninstalled are moved to ROMs\..\_removed.
  Only shortcuts this script makes (steam:// and Epic links, and .lnk files
  it labels "Luma Arcade PC game") are ever touched; anything else in those
  folders is left alone.

  Runs as the games account (scheduled task \LumaArcade\PC Games, at sign-in
  and early each morning, at the end of Setup, or "Import now" in Host
  health). ES-DE rewrites its game lists when it closes, so:
    - nothing new or gone: stop;
    - someone streaming: stop, the next run tries again;
    - ES-DE open: close it the normal way (it saves its lists), sync, and
      leave it closed - the next stream starts it again.
  Result: C:\ProgramData\LumaArcade\home\pc-games.json (Host health shows it)
  Log:    C:\ProgramData\LumaArcade\home\pc-games.log

  -Check     only say what would change
  -Force     sync even when nothing changed (refreshes names and artwork)
  -EsDeDir   ES-DE's folder, when there's no host.json (Setup's "ES-DE and
             emulators" install, without Luma Arcade)
#>
param([switch]$Check, [switch]$Force, [string]$EsDeDir = '')
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
# What this script writes into its .lnk files, to know them again.
$lnkTag = 'Luma Arcade PC game: '
$githubUrl = 'https://github.com/Luma-exe/luma-arcade'
$githubMarker = Join-Path $homeDir 'github-shortcut-added'

function SafeName([string]$name) { (($name -replace '[\\/:*?"<>|]', '_') -replace '[^\u0020-\uFFFF]', '').Trim() }

# --- where ES-DE keeps things (host.json from Setup, ES-DE's own settings)

function Get-EsDe {
    $hostFile = Join-Path $dataDir 'host.json'
    if (Test-Path $hostFile) {
        $config = Get-Content $hostFile -Raw | ConvertFrom-Json
        if (-not $config.esDeDir -or -not $config.gamelists) { throw 'host.json has no ES-DE folder - run Setup again' }
        $esDir = $config.esDeDir; $gamelists = $config.gamelists
    } elseif ($EsDeDir) {
        # The portable ES-DE keeps its settings in ES-DE\ES-DE, the installed one in the profile.
        $esDir = $EsDeDir
        $esData = if (Test-Path (Join-Path $EsDeDir 'portable.txt')) { Join-Path $EsDeDir 'ES-DE' } else { Join-Path $env:USERPROFILE 'ES-DE' }
        $gamelists = Join-Path $esData 'gamelists'
    } else { throw 'no host.json and no -EsDeDir - run Setup again' }
    $esData = Split-Path $gamelists
    $settings = @{}
    $file = Join-Path $esData 'settings\es_settings.xml'
    if (Test-Path $file) {
        foreach ($m in [regex]::Matches((Get-Content $file -Raw), '<string name="(\w+)" value="([^"]*)"')) { $settings[$m.Groups[1].Value] = $m.Groups[2].Value }
    }
    $expand = { param($p) if ($p) { $p.Replace('%ESPATH%', $esDir).Replace('~', $env:USERPROFILE) } }
    $roms = & $expand $settings['ROMDirectory']
    if (-not $roms) { $roms = Join-Path $esDir 'ROMs' }
    $media = & $expand $settings['MediaDirectory']
    if (-not $media) { $media = Join-Path $esData 'downloaded_media' }
    [pscustomobject]@{ Roms = $roms; Media = $media; Gamelists = $gamelists }
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

# A game for ES-DE's "Microsoft Windows" system: a .lnk to Target.
function New-WindowsGame([string]$Id, [string]$Name, [string]$Launcher, [string]$Target, [string]$Arguments = '', [string]$WorkingDir = '', [string]$Desc = '') {
    if (-not $Name) { return }
    [pscustomobject]@{ System = 'windows'; Id = $Id; Name = $Name; Launcher = $Launcher; File = "$(SafeName $Name).lnk"
        Target = $Target; Arguments = $Arguments; WorkingDir = $WorkingDir; Desc = $Desc; Art = $null }
}

function Get-UninstallEntries {
    Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue
}

# Xbox app (Game Pass, Microsoft Store PC games): each drive's games folder
# (named in its .GamingRoot file, XboxGames by default) holds
# <game>\Content\MicrosoftGame.config. They start through their app id.
function Get-XboxGames {
    $roots = foreach ($drive in [IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady }) {
        $root = $drive.RootDirectory.FullName
        $marker = Join-Path $root '.GamingRoot'
        if (Test-Path $marker) {
            # "RGBX", a count, then the folder in UTF-16.
            $bytes = [IO.File]::ReadAllBytes($marker)
            if ($bytes.Length -gt 8) {
                $folder = [Text.Encoding]::Unicode.GetString($bytes, 8, $bytes.Length - 8).Trim([char]0)
                if ($folder) { Join-Path $root $folder.TrimStart('\') }
            }
        }
        Join-Path $root 'XboxGames'
    }
    $seen = @{}
    foreach ($root in $roots | Select-Object -Unique) {
        if (-not (Test-Path $root)) { continue }
        foreach ($config in Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'Content\MicrosoftGame.config' } | Where-Object { Test-Path $_ }) {
            try { [xml]$xml = Get-Content $config -Raw } catch { continue }
            $identity = $xml.Game.Identity.Name
            if (-not $identity -or $seen[$identity]) { continue }
            # Only games this account can start.
            $pkg = Get-AppxPackage -Name $identity -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $pkg) { continue }
            $seen[$identity] = $true
            $appId = @($xml.Game.ExecutableList.Executable)[0].Id
            if (-not $appId) { $appId = 'Game' }
            $name = $xml.Game.ShellVisuals.DefaultDisplayName
            if (-not $name -or $name -like 'ms-resource:*') { $name = Split-Path (Split-Path (Split-Path $config)) -Leaf }
            New-WindowsGame "xbox:$identity" $name 'Xbox app' "$env:SystemRoot\explorer.exe" "shell:AppsFolder\$($pkg.PackageFamilyName)!$appId"
        }
    }
}

# EA app (and Origin): EA's installer registers each game for uninstalling;
# its icon is the game itself, which brings the EA app up when it starts.
function Get-EaGames {
    foreach ($e in Get-UninstallEntries | Where-Object { $_.UninstallString -match 'EAInstaller' -and $_.DisplayName }) {
        $exe = ($e.DisplayIcon -replace ',\s*-?\d+$', '').Trim('"')
        if (-not $exe -or $exe -notmatch '\.exe$' -or -not (Test-Path $exe)) { continue }
        New-WindowsGame "ea:$($e.PSChildName)" $e.DisplayName 'EA app' $exe '' (Split-Path $exe)
    }
}

# GOG (Galaxy or the offline installers): one registry key per game; DLC
# names the game it belongs to.
function Get-GogGames {
    foreach ($g in Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\GOG.com\Games\*' -ErrorAction SilentlyContinue) {
        if ($g.dependsOn -or -not $g.exe -or -not (Test-Path $g.exe)) { continue }
        $dir = if ($g.workingDir -and (Test-Path $g.workingDir)) { $g.workingDir } else { Split-Path $g.exe }
        New-WindowsGame "gog:$($g.gameID)" $g.gameName 'GOG' $g.exe "$($g.launchParam)" $dir
    }
}

# Ubisoft Connect: its installs, started through uplay:// so it signs in.
function Get-UbisoftGames {
    $uninstall = @{}
    foreach ($e in Get-UninstallEntries | Where-Object { $_.PSChildName -match '^Uplay Install (\d+)$' }) { $uninstall[$Matches[1]] = $e.DisplayName }
    foreach ($k in Get-ChildItem 'HKLM:\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs' -ErrorAction SilentlyContinue) {
        $id = $k.PSChildName
        $dir = (Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue).InstallDir
        if (-not $dir -or -not (Test-Path $dir)) { continue }
        $name = if ($uninstall[$id]) { $uninstall[$id] } else { Split-Path $dir.TrimEnd('/', '\') -Leaf }
        New-WindowsGame "ubisoft:$id" $name 'Ubisoft Connect' "$env:SystemRoot\explorer.exe" "uplay://launch/$id/0"
    }
}

# Luma Arcade's own page, once (deleting it from ES-DE keeps it gone).
function Get-GithubShortcut($romDir) {
    $file = 'Luma Arcade on GitHub.lnk'
    if ((Test-Path $githubMarker) -and -not (Test-Path (Join-Path $romDir "windows\$file"))) { return }
    $g = New-WindowsGame 'luma:github' 'Luma Arcade on GitHub' 'Luma Arcade' "$env:SystemRoot\explorer.exe" $githubUrl '' `
        'Luma Arcade is free and open source. Opens its GitHub page: what''s new, how it works, reporting a problem - and a star helps it grow.'
    $g.File = $file
    $g
}

# --- shortcuts already there (only the kinds this script makes)

$shell = New-Object -ComObject WScript.Shell

function Get-Shortcuts($romDir, $system) {
    $folder = Join-Path $romDir $system
    if (-not (Test-Path $folder)) { return @() }
    if ($system -eq 'windows') {
        foreach ($l in Get-ChildItem $folder -Filter *.lnk) {
            $desc = $shell.CreateShortcut($l.FullName).Description
            if ($desc -like "$lnkTag*") { [pscustomobject]@{ System = $system; File = $l.Name; Path = $l.FullName; Url = $null; Id = $desc.Substring($lnkTag.Length) } }
        }
        return
    }
    foreach ($u in Get-ChildItem $folder -Filter *.url) {
        $url = (Get-Content $u.FullName | Where-Object { $_ -like 'URL=*' } | Select-Object -First 1) -replace '^URL=', ''
        if ($url -like 'steam://*' -or $url -like 'com.epicgames.launcher://*') { [pscustomobject]@{ System = $system; File = $u.Name; Path = $u.FullName; Url = $url; Id = $null } }
    }
}

# --- writing

function Add-ToGamelist($gamelists, $system, $entries) {
    $file = Join-Path $gamelists "$system\gamelist.xml"
    New-Item -ItemType Directory -Force (Split-Path $file) | Out-Null
    if (Test-Path $file) { [xml]$xml = Get-Content $file -Raw -Encoding UTF8 } else { [xml]$xml = '<?xml version="1.0"?><gameList />' }
    # (An empty <gameList /> reads as "" - falsy - so look for the node itself.)
    $root = $xml.SelectSingleNode('/gameList')
    if (-not $root) { $root = $xml.AppendChild($xml.CreateElement('gameList')) }
    $changed = $false
    foreach ($g in $entries) {
        $rel = "./$($g.File)"
        if ($root.SelectNodes('game') | Where-Object { $_.path -eq $rel }) { continue }
        $entry = $xml.CreateElement('game')
        $p = $xml.CreateElement('path'); $p.InnerText = $rel; [void]$entry.AppendChild($p)
        $n = $xml.CreateElement('name'); $n.InnerText = $g.Name; [void]$entry.AppendChild($n)
        if ($g.Desc) { $d = $xml.CreateElement('desc'); $d.InnerText = $g.Desc; [void]$entry.AppendChild($d) }
        if ($g.Launcher -and $g.Id -notlike 'luma:*') { $d = $xml.CreateElement('publisher'); $d.InnerText = $g.Launcher; [void]$entry.AppendChild($d) }
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

function Write-Lnk($game, $path) {
    $s = $shell.CreateShortcut($path)
    $s.TargetPath = $game.Target
    $s.Arguments = $game.Arguments
    if ($game.WorkingDir) { $s.WorkingDirectory = $game.WorkingDir }
    if ($game.Target -notlike '*explorer.exe') { $s.IconLocation = "$($game.Target),0" }
    $s.Description = "$lnkTag$($game.Id)"
    $s.Save()
}

# --- the run

try {
    $es = Get-EsDe
    $windows = @(Get-XboxGames) + @(Get-EaGames) + @(Get-GogGames) + @(Get-UbisoftGames)
    # Two launchers with the same game name: the second gets its launcher in the name.
    $names = @{}
    foreach ($g in $windows) { if ($names[$g.File]) { $g.Name = "$($g.Name) ($($g.Launcher))"; $g.File = "$(SafeName $g.Name).lnk" }; $names[$g.File] = $true }
    $installed = @(Get-SteamGames) + @(Get-EpicGames) + $windows + @(Get-GithubShortcut $es.Roms)
    $existing = @(Get-Shortcuts $es.Roms 'steam') + @(Get-Shortcuts $es.Roms 'epic') + @(Get-Shortcuts $es.Roms 'windows')
    # An Epic game already linked from the Steam folder (set up by hand) counts as there.
    $haveUrl = @{}; foreach ($s in $existing | Where-Object Url) { $haveUrl[$s.Url] = $true }
    $haveEpic = @{}; foreach ($s in $existing | Where-Object { $_.Url -like 'com.epicgames.launcher://*' }) { if ($s.Url -match '%3A([^?%]+)\?') { $haveEpic[$Matches[1]] = $true } }
    $haveLnk = @{}; foreach ($s in $existing | Where-Object Id) { $haveLnk[$s.Id] = $true }
    $new = @($installed | Where-Object {
        if ($_.System -eq 'windows') { -not $haveLnk[$_.Id] }
        else { -not ($haveUrl[$_.Url] -or ($_.System -eq 'epic' -and $haveEpic[$_.Id])) }
    })
    $wantedUrls = @{}; foreach ($g in $installed | Where-Object Url) { $wantedUrls[$g.Url] = $true }
    $wantedEpic = @{}; foreach ($g in $installed | Where-Object System -eq 'epic') { $wantedEpic[$g.Id] = $true }
    $wantedLnk = @{}; foreach ($g in $installed | Where-Object System -eq 'windows') { $wantedLnk[$g.Id] = $true }
    $gone = @($existing | Where-Object {
        if ($_.Id) { $_.Id -notlike 'luma:*' -and -not $wantedLnk[$_.Id] }
        elseif ($_.Url -like 'steam://*') { -not $wantedUrls[$_.Url] }
        elseif ($_.Url -match '%3A([^?%]+)\?') { -not $wantedEpic[$Matches[1]] }
        else { $false }
    })
    $others = @($windows)
    $counts = @{ steam = @($installed | Where-Object System -eq 'steam').Count; epic = @($installed | Where-Object System -eq 'epic').Count; other = $others.Count }
    $byLauncher = [ordered]@{}; foreach ($g in $others) { $byLauncher[$g.Launcher] = 1 + [int]$byLauncher[$g.Launcher] }
    function Status($extra) { @{ at = (Get-Date).ToString('o'); steam = $counts.steam; epic = $counts.epic; other = $counts.other; launchers = $byLauncher } + $extra }

    if ($Check) {
        "Steam: $($counts.steam) installed, Epic: $($counts.epic) installed, others: $($counts.other) ($(($byLauncher.GetEnumerator() | ForEach-Object { "$($_.Key) $($_.Value)" }) -join ', '))"
        $new | ForEach-Object { "would add: $($_.Name) ($($_.System))" }
        $gone | ForEach-Object { "would move out: $($_.File) ($($_.System))" }
        exit 0
    }
    if (-not $new.Count -and -not $gone.Count -and -not $Force) {
        SaveStatus (Status @{ added = @(); removed = @(); waiting = $null })
        exit 0
    }
    if (Get-Process streamer -ErrorAction SilentlyContinue) {
        $why = "someone is streaming; trying again later ($($new.Count) new, $($gone.Count) gone)"
        Log $why
        SaveStatus (Status @{ added = @(); removed = @(); waiting = $why })
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
        if ($g.System -eq 'windows') { Write-Lnk $g $file }
        elseif (-not (Test-Path $file)) { Set-Content $file "[InternetShortcut]`r`nURL=$($g.Url)" -Encoding ASCII }
        if ($g.System -eq 'steam') { Copy-SteamArt $g $es.Media }
        if ($g.Id -eq 'luma:github') {
            Set-Content $githubMarker (Get-Date -Format s)
            # The Luma star as its picture (Setup leaves it next to this script).
            $star = Join-Path $dataDir 'luma-star.png'
            $covers = Join-Path $es.Media 'windows\covers'
            if ((Test-Path $star) -and -not (Test-Path (Join-Path $covers 'Luma Arcade on GitHub.png'))) {
                New-Item -ItemType Directory -Force $covers | Out-Null
                Copy-Item $star (Join-Path $covers 'Luma Arcade on GitHub.png')
            }
        }
    }
    foreach ($system in 'steam', 'epic', 'windows') {
        $entries = @($installed | Where-Object { $_.System -eq $system -and (Test-Path (Join-Path $es.Roms "$system\$($_.File)")) })
        if ($entries.Count) { Add-ToGamelist $es.Gamelists $system $entries }
    }
    $removedDir = Join-Path (Split-Path $es.Roms) '_removed'
    foreach ($s in $gone) {
        $to = Join-Path $removedDir $s.System
        New-Item -ItemType Directory -Force $to | Out-Null
        Move-Item $s.Path (Join-Path $to $s.File) -Force
    }
    $added = @($new | Where-Object { $_.Id -ne 'luma:github' } | ForEach-Object { $_.Name })
    $removed = @($gone | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension($_.File) })
    Log "synced: $($added.Count) new ($($added -join ', ')), $($removed.Count) gone ($($removed -join ', '))"
    SaveStatus (Status @{ added = $added; removed = $removed; waiting = $null })
} catch {
    Log "failed: $($_.Exception.Message)"
    SaveStatus @{ at = (Get-Date).ToString('o'); error = $_.Exception.Message }
    exit 1
}
