# Per-player saves for LumaArcade. Sunshine runs this (the first prep-cmd
# on the ES-DE app) just before it starts ES-DE for a stream. It asks
# LumaArcade whose stream is starting, then:
#
#  1. swaps every emulator save folder below for that player's own: the
#     folder in use is renamed to "<folder>.profiles\<its owner>" and the
#     player's is renamed to "<folder>". Renames on one drive are instant and
#     work on exFAT (G:), which can't hold junctions. The first time, the
#     folder becomes "<folder>.profiles\_shared" (the saves everyone had
#     until now); a new player's saves start as a copy of it.
#  2. swaps ES-DE's per-player stats (favorite, playcount, lastplayed,
#     completed) in its game lists: the previous player's are saved to their
#     profile, this player's are written in.
#
# It changes nothing while ES-DE or an emulator is running (a game left open
# and taken over keeps writing where it was). Which player's saves each
# folder holds is recorded in profiles\state.json after every step, so an
# interrupted switch picks up where it stopped.
#
# LumaArcade also runs it for save snapshots (routes/saves.ts):
#   -Action snapshot -Player "<id>:<name>" [-Label <text>]
#   -Action list     -Player "<id>:<name>"
#   -Action restore  -Player "<id>:<name>" -Snapshot <name>
# and to hand a guest link's saves to a new account (routes/guestLinks.ts):
#   -Action transfer -From <guest id> -To "<new id>:<name>"
# Those print one line of JSON for it to read.
#
# Deployed copy: C:\ProgramData\LumaArcade\profiles.ps1. See host/README.md.
param(
    [ValidateSet('switch', 'snapshot', 'list', 'restore', 'transfer')]
    [string]$Action = 'switch',
    [switch]$DryRun,
    # The player, instead of asking LumaArcade: "<id>:<name>"
    [string]$Player,
    [string]$Snapshot,
    [string]$Label,
    # transfer: whose saves (a user id), and who gets them ("<id>:<name>")
    [string]$From,
    [string]$To,
    [int]$Port = 4500,
    # Run against a copy of the folder layout under this folder (testing)
    [string]$TestRoot
)

$ErrorActionPreference = 'Stop'
$Root = 'C:\ProgramData\LumaArcade\profiles'
$E = 'G:\ES-DE\Emulators'
$R = 'C:\Users\Arcade\AppData\Roaming'
$Gamelists = 'C:\Users\Arcade\ES-DE\gamelists'
$EsDeDir = 'G:\ES-DE'
$SnapshotRoot = 'E:\GameSaveBackups\snapshots'
if ($TestRoot) {
    $Root = "$TestRoot\profiles"; $EsDeDir = $TestRoot; $SnapshotRoot = "$TestRoot\snapshots"
    $E = "$TestRoot\Emulators"; $R = "$TestRoot\Roaming"; $Gamelists = "$TestRoot\gamelists"
}
$LogFile = Join-Path $Root 'profiles.log'
$StateFile = Join-Path $Root 'state.json'
$StatFields = 'favorite', 'playcount', 'lastplayed', 'completed'
# Snapshots kept per player; the oldest go first.
$KeepSnapshots = 10

# slot => @(folder, seed). seed: a new player's saves start as a copy of the
# shared ones (in-game saves and memory cards); save states start empty,
# they're tied to one person's moment in a game.
# Left shared on purpose: Azahar's sdmc/nand and Xenia's content hold
# installed games/DLC next to the saves, xemu's hdd is one disk image.
$Slots = [ordered]@{
    'RetroArch-saves'      = @("$E\RetroArch-Win64\saves", $true)
    'RetroArch-states'     = @("$E\RetroArch-Win64\states", $false)
    'Dolphin-GC'           = @("$R\Dolphin Emulator\GC", $true)
    'Dolphin-Wii-title'    = @("$R\Dolphin Emulator\Wii\title", $true)
    'Dolphin-StateSaves'   = @("$R\Dolphin Emulator\StateSaves", $false)
    'PCSX2-memcards'       = @("$E\PCSX2-Qt\memcards", $true)
    'PCSX2-sstates'        = @("$E\PCSX2-Qt\sstates", $false)
    'DuckStation-memcards' = @("$E\duckstation\memcards", $true)
    'DuckStation-states'   = @("$E\duckstation\savestates", $false)
    'PPSSPP-SAVEDATA'      = @("$E\PPSSPP\memstick\PSP\SAVEDATA", $true)
    'PPSSPP-STATE'         = @("$E\PPSSPP\memstick\PSP\PPSSPP_STATE", $false)
    'RPCS3-savedata'       = @("$E\RPCS3\dev_hdd0\home\00000001\savedata", $true)
    'Cemu-save'            = @("$R\Cemu\mlc01\usr\save", $true)
    'Eden-save'            = @("$E\eden\user\nand\user\save", $true)
    'Vita3K-user'          = @("$E\Vita3K\ux0\user", $true)
    'Supermodel-NVRAM'     = @("$E\Supermodel\NVRAM", $true)
    'Supermodel-Saves'     = @("$E\Supermodel\Saves", $true)
}

New-Item -ItemType Directory -Force -Path $Root | Out-Null

function Log([string]$Text) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $(if ($DryRun) { '[dry run] ' })$Text"
    Add-Content -Path $LogFile -Value $line -Encoding utf8
}

function Reply($Object) {
    $Object | ConvertTo-Json -Depth 5 -Compress
}

function Busy {
    return Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path -like "$EsDeDir\*" } |
        Select-Object -ExpandProperty ProcessName -Unique
}

function Copy-Tree([string]$From, [string]$To, [switch]$Mirror) {
    New-Item -ItemType Directory -Force -Path $To | Out-Null
    $mode = if ($Mirror) { '/MIR' } else { '/E' }
    robocopy $From $To $mode /R:1 /W:1 /NP /NFL /NDL /NJH /NJS | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "copying $From to $To failed (robocopy $LASTEXITCODE)" }
}

# --- state: which player's saves each folder holds right now

$state = @{ current = $null; name = $null; slots = @{} }
if (Test-Path $StateFile) {
    $saved = Get-Content $StateFile -Raw | ConvertFrom-Json
    $state.current = $saved.current
    $state.name = $saved.name
    if ($saved.slots) { foreach ($p in $saved.slots.PSObject.Properties) { $state.slots[$p.Name] = $p.Value } }
}

function Save-State {
    if ($DryRun) { return }
    $state.since = (Get-Date).ToString('o')
    $state | ConvertTo-Json -Depth 4 | Set-Content $StateFile -Encoding utf8
}

# --- ES-DE stats

# ES-DE's gamelist.xml isn't one XML document: <alternativeEmulator> sits
# next to <gameList> at the top. So it's read wrapped in a root element and
# written back without it, byte for byte apart from the changed stats.
$Utf8 = New-Object Text.UTF8Encoding $false

function Open-Gamelist([string]$Path) {
    $text = [IO.File]::ReadAllText($Path, $Utf8)
    $m = [regex]::Match($text, '^\s*<\?xml[^>]*\?>\r?\n?')
    $xml = New-Object xml
    $xml.PreserveWhitespace = $true
    $xml.LoadXml("<lumaRoot>$($text.Substring($m.Length))</lumaRoot>")
    return @{ xml = $xml; declaration = $m.Value }
}

function Save-Gamelist([string]$Path, $Doc) {
    [IO.File]::WriteAllText($Path, $Doc.declaration + $Doc.xml.DocumentElement.InnerXml, $Utf8)
}

function Read-Stats {
    $stats = @{}
    foreach ($file in Get-ChildItem $Gamelists -Filter gamelist.xml -Recurse -ErrorAction SilentlyContinue) {
        $system = $file.Directory.Name
        $xml = (Open-Gamelist $file.FullName).xml
        foreach ($game in $xml.SelectNodes('/lumaRoot/gameList/game')) {
            $entry = @{}
            foreach ($f in $StatFields) {
                $node = $game.SelectSingleNode($f)
                if ($node) { $entry[$f] = $node.InnerText }
            }
            if ($entry.Count) { $stats["$system|$($game.path)"] = $entry }
        }
    }
    return $stats
}

function Write-Stats($Stats) {
    foreach ($file in Get-ChildItem $Gamelists -Filter gamelist.xml -Recurse -ErrorAction SilentlyContinue) {
        $system = $file.Directory.Name
        $doc = Open-Gamelist $file.FullName
        $xml = $doc.xml
        $changed = $false
        foreach ($game in $xml.SelectNodes('/lumaRoot/gameList/game')) {
            $want = $Stats["$system|$($game.path)"]
            foreach ($f in $StatFields) {
                $node = $game.SelectSingleNode($f)
                $value = if ($want) { $want.$f } else { $null }
                if ($null -eq $value) {
                    if ($node) { [void]$game.RemoveChild($node); $changed = $true }
                }
                elseif (-not $node) {
                    $node = $xml.CreateElement($f)
                    $node.InnerText = $value
                    [void]$game.AppendChild($node)
                    $changed = $true
                }
                elseif ($node.InnerText -ne $value) {
                    $node.InnerText = $value
                    $changed = $true
                }
            }
        }
        if ($changed -and -not $DryRun) { Save-Gamelist $file.FullName $doc }
    }
}

function Stats-File([string]$Id) { Join-Path (Join-Path $Root $Id) 'esde-stats.json' }

function Read-StatsFile([string]$File) {
    if (-not (Test-Path $File)) { return $null }
    $stats = @{}
    foreach ($p in (Get-Content $File -Raw | ConvertFrom-Json).PSObject.Properties) {
        $entry = @{}
        foreach ($q in $p.Value.PSObject.Properties) { $entry[$q.Name] = [string]$q.Value }
        $stats[$p.Name] = $entry
    }
    return $stats
}

function Write-StatsFile([string]$File, $Stats) {
    if ($DryRun) { return }
    New-Item -ItemType Directory -Force -Path (Split-Path $File) | Out-Null
    $Stats | ConvertTo-Json -Depth 4 -Compress | Set-Content $File -Encoding utf8
}

# --- save folders

function Owner([string]$Slot, [string]$Path) {
    if ($state.slots.ContainsKey($Slot)) { return $state.slots[$Slot] }
    # Never switched: whatever is there is everyone's.
    if (Test-Path -LiteralPath $Path) { return '_shared' }
    return $null
}

# Where this player's saves for a slot are right now (in use or put away).
function SlotDir([string]$Slot, [string]$Path, [string]$Id) {
    if ((Owner $Slot $Path) -eq $Id) { return $Path }
    return Join-Path "$Path.profiles" $Id
}

function Swap-Slot([string]$Slot, [string]$Path, [bool]$Seed, [string]$Id, [string]$Name) {
    $owner = Owner $Slot $Path
    if ($owner -eq $Id) { return }
    $store = "$Path.profiles"
    $mine = Join-Path $store $Id

    # Put away whoever's saves are in use.
    if (Test-Path -LiteralPath $Path) {
        if (-not $owner) { $owner = '_shared' }
        $away = Join-Path $store $owner
        if (Test-Path -LiteralPath $away) {
            Log "$Slot`: $Path and $away both exist; left alone - merge them by hand"
            return
        }
        Log "$Slot`: putting $owner's saves away"
        if (-not $DryRun) {
            New-Item -ItemType Directory -Force -Path $store | Out-Null
            Move-Item -LiteralPath $Path -Destination $away
            $state.slots[$Slot] = $null
            Save-State
        }
    }

    # Bring this player's in, or start them from the shared saves.
    try {
        if (Test-Path -LiteralPath $mine) {
            if (-not $DryRun) {
                New-Item -ItemType Directory -Force -Path (Split-Path $Path) | Out-Null
                Move-Item -LiteralPath $mine -Destination $Path
            }
        }
        else {
            $shared = Join-Path $store '_shared'
            Log "$Slot`: first time for $Name$(if ($Seed -and (Test-Path -LiteralPath $shared)) { ', starting from the shared saves' })"
            if (-not $DryRun) {
                if ($Seed -and (Test-Path -LiteralPath $shared)) { Copy-Tree $shared $Path }
                else { New-Item -ItemType Directory -Force -Path $Path | Out-Null }
            }
        }
    }
    catch {
        Log "$Slot`: couldn't bring in $Name's saves ($($_.Exception.Message))"
        # Put the previous owner's back rather than leave the folder missing.
        if (-not $DryRun -and $owner -and -not (Test-Path -LiteralPath $Path) -and (Test-Path -LiteralPath (Join-Path $store $owner))) {
            Move-Item -LiteralPath (Join-Path $store $owner) -Destination $Path
            $state.slots[$Slot] = $owner
            Save-State
        }
        return
    }
    $state.slots[$Slot] = $Id
    Save-State
}

# --- who

function Who {
    if ($Player) {
        $id, $name = $Player -split ':', 2
        # moonlight-web-stream's user ids go past 32 bits
        return [pscustomobject]@{ id = [long]$id; name = $(if ($name) { $name } else { "Player $id" }) }
    }
    try {
        return (Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/profiles/current" -TimeoutSec 5 -UseBasicParsing).user
    }
    catch {
        Log "Couldn't ask LumaArcade who is playing ($($_.Exception.Message)); saves left as they are"
        return $null
    }
}

# --- snapshots: a copy of one player's saves and stats, wherever they are

function Snapshot-Dir([string]$Id) { Join-Path $SnapshotRoot $Id }

function List-Snapshots([string]$Id) {
    $dir = Snapshot-Dir $Id
    if (-not (Test-Path $dir)) { return @() }
    return @(Get-ChildItem $dir -Directory | Sort-Object Name -Descending | ForEach-Object {
        $meta = Join-Path $_.FullName 'snapshot.json'
        $info = if (Test-Path $meta) { Get-Content $meta -Raw | ConvertFrom-Json } else { $null }
        [ordered]@{
            name   = $_.Name
            time   = $(if ($info) { $info.time } else { $_.CreationTime.ToString('o') })
            label  = $(if ($info) { $info.label } else { '' })
            slots  = $(if ($info) { $info.slots } else { @() })
            sizeKB = [math]::Round(((Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum) / 1KB)
        }
    })
}

function Take-Snapshot($Who, [string]$Text) {
    $id = "user-$($Who.id)"
    $name = Get-Date -Format 'yyyyMMdd-HHmmss'
    $dest = Join-Path (Snapshot-Dir $id) $name
    $copied = @()
    foreach ($slot in $Slots.Keys) {
        $src = SlotDir $slot $Slots[$slot][0] $id
        if (-not (Test-Path -LiteralPath $src)) { continue }
        Copy-Tree $src (Join-Path $dest $slot)
        $copied += $slot
    }
    # Their ES-DE stats: live in the game lists if theirs are loaded.
    $stats = if ($state.current -eq $id) { Read-Stats } else { Read-StatsFile (Stats-File $id) }
    if ($stats) { Write-StatsFile (Join-Path $dest 'esde-stats.json') $stats }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    [ordered]@{ time = (Get-Date).ToString('o'); label = $Text; player = $Who.name; slots = $copied } |
        ConvertTo-Json | Set-Content (Join-Path $dest 'snapshot.json') -Encoding utf8
    Get-ChildItem (Snapshot-Dir $id) -Directory | Sort-Object Name -Descending |
        Select-Object -Skip $KeepSnapshots | ForEach-Object { Remove-Item $_.FullName -Recurse -Force }
    Log "Snapshot $name of $($Who.name)'s saves ($($copied.Count) folders)$(if ($Text) { ": $Text" })"
    return $name
}

# --- transfer: everything one player has (saves wherever they are, ES-DE
# stats, snapshots) becomes another's. Renames only, so it's instant; the
# new owner must have nothing yet. All destinations are checked before
# anything moves, so it never stops halfway.

function Transfer([string]$FromId, [string]$ToId, [string]$ToName) {
    $moves = @()
    $relabel = @()
    foreach ($slot in $Slots.Keys) {
        $path = $Slots[$slot][0]
        if ((Owner $slot $path) -eq $FromId) { $relabel += $slot; continue }
        $src = Join-Path "$path.profiles" $FromId
        if (Test-Path -LiteralPath $src) { $moves += , @($src, (Join-Path "$path.profiles" $ToId)) }
    }
    foreach ($pair in @(@((Join-Path $Root $FromId), (Join-Path $Root $ToId)), @((Snapshot-Dir $FromId), (Snapshot-Dir $ToId)))) {
        if (Test-Path -LiteralPath $pair[0]) { $moves += , $pair }
    }
    foreach ($slot in $Slots.Keys) {
        $path = $Slots[$slot][0]
        if ((Owner $slot $path) -eq $ToId -or (Test-Path -LiteralPath (Join-Path "$path.profiles" $ToId))) {
            throw "$ToName already has saves for $slot - transfer to a new account"
        }
    }
    foreach ($pair in $moves) {
        if (Test-Path -LiteralPath $pair[1]) { throw "$($pair[1]) already exists - transfer to a new account" }
    }
    if ($DryRun) { return @{ moved = $moves.Count; relabelled = $relabel.Count } }

    foreach ($pair in $moves) { Move-Item -LiteralPath $pair[0] -Destination $pair[1] }
    foreach ($slot in $relabel) { $state.slots[$slot] = $ToId }
    if ($state.current -eq $FromId) {
        $state.current = $ToId
        $state.name = $ToName
    }
    Save-State
    if (Test-Path (Join-Path $Root $ToId)) { Set-Content (Join-Path (Join-Path $Root $ToId) 'name.txt') $ToName -Encoding utf8 }
    Log "Gave $FromId's saves to $ToName ($ToId): $($moves.Count) folders moved, $($relabel.Count) in use now"
    return @{ moved = $moves.Count; relabelled = $relabel.Count }
}

# --- go

if ($Action -eq 'transfer') {
    try {
        if ($From -notmatch '^\d+$') { throw 'From must be a user id' }
        $toId, $toName = $To -split ':', 2
        if ($toId -notmatch '^\d+$') { throw 'To must be "<id>:<name>"' }
        if ($toId -eq $From) { throw 'Those are the same account' }
        $result = Transfer "user-$From" "user-$toId" $(if ($toName) { $toName } else { "Player $toId" })
        Reply @{ transferred = $true; moved = $result.moved; relabelled = $result.relabelled }
    }
    catch {
        Log "transfer failed: $($_.Exception.Message)"
        Reply @{ error = $_.Exception.Message }
        exit 1
    }
    exit 0
}

if ($Action -ne 'switch') {
    $who = Who
    if (-not $who) { Reply @{ error = 'No player given' }; exit 1 }
    $id = "user-$($who.id)"
    try {
        switch ($Action) {
            'list' { Reply @{ snapshots = @(List-Snapshots $id) } }
            'snapshot' { Reply @{ snapshot = (Take-Snapshot $who $Label) } }
            'restore' {
                $src = Join-Path (Snapshot-Dir $id) $Snapshot
                if (-not $Snapshot -or $Snapshot -match '[\\/.]' -or -not (Test-Path $src)) { Reply @{ error = 'No such snapshot' }; exit 1 }
                $busy = Busy
                if ($busy) { Reply @{ error = "A game is still running ($($busy -join ', ')). Close it first." }; exit 1 }
                $before = Take-Snapshot $who 'Before restoring'
                foreach ($slot in $Slots.Keys) {
                    $from = Join-Path $src $slot
                    if (Test-Path $from) { Copy-Tree $from (SlotDir $slot $Slots[$slot][0] $id) -Mirror }
                }
                $stats = Read-StatsFile (Join-Path $src 'esde-stats.json')
                if ($stats) {
                    if ($state.current -eq $id) { Write-Stats $stats }
                    Write-StatsFile (Stats-File $id) $stats
                }
                Log "Restored $($who.name)'s saves from snapshot $Snapshot (kept the ones before as $before)"
                Reply @{ restored = $Snapshot; before = $before }
            }
        }
    }
    catch {
        Log "$Action failed: $($_.Exception.Message)"
        Reply @{ error = $_.Exception.Message }
        exit 1
    }
    exit 0
}

$who = Who
if (-not $who) {
    if (-not $Player) { Log 'LumaArcade doesn''t know who is playing; saves left as they are' }
    exit 0
}
$profileId = "user-$($who.id)"
$busy = Busy
if ($busy) {
    Log "Not switching to $($who.name): still running: $($busy -join ', ')"
    exit 0
}

$previous = $state.current
try {
    if ($previous -ne $profileId) {
        Log "Switching saves from $(if ($previous) { $state.name } else { 'everyone (first run)' }) to $($who.name) ($profileId)"
        # Whose stats are in the game lists now: the previous player's, or on
        # the very first run everyone's, which new players start from.
        $current = Read-Stats
        Write-StatsFile (Stats-File $(if ($previous) { $previous } else { '_shared' })) $current
    }

    foreach ($slot in $Slots.Keys) {
        try { Swap-Slot $slot $Slots[$slot][0] $Slots[$slot][1] $profileId $who.name }
        catch { Log "$slot`: $($_.Exception.Message)" }
    }

    if ($previous -ne $profileId) {
        $stats = Read-StatsFile (Stats-File $profileId)
        if ($null -eq $stats) { $stats = Read-StatsFile (Stats-File '_shared') }
        if ($null -eq $stats) { $stats = $current }
        Write-Stats $stats
        Write-StatsFile (Stats-File $profileId) $stats
        $state.current = $profileId
        $state.name = $who.name
        Save-State
        Log "Now using $($who.name)'s saves"
    }
}
catch {
    Log "Failed: $($_.Exception.Message)"
}
exit 0
