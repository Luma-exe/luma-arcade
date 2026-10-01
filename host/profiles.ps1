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
#   -Action snapshot -Player "<id>:<name>" [-Label <text>] [-Auto]
#     (-Auto: taken by LumaArcade when a game closes; those are pruned on
#     their own, so they never push out a player's own snapshots)
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
    [switch]$Auto,
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
$Bios = 'G:\BIOS'
# A PC set up by the Luma Arcade installer says where things are in
# host.json (installer/scripts/install-host.ps1); the paths above are the
# original gaming PC's.
$HostFile = 'C:\ProgramData\LumaArcade\host.json'
$LumaUrl = "http://127.0.0.1:$Port"
if (-not $TestRoot -and (Test-Path $HostFile)) {
    $hostConfig = Get-Content -Raw $HostFile | ConvertFrom-Json
    if ($hostConfig.emulators) { $E = $hostConfig.emulators }
    if ($hostConfig.roaming) { $R = $hostConfig.roaming }
    if ($hostConfig.gamelists) { $Gamelists = $hostConfig.gamelists }
    if ($hostConfig.esDeDir) { $EsDeDir = $hostConfig.esDeDir }
    if ($hostConfig.snapshots) { $SnapshotRoot = $hostConfig.snapshots }
    if ($hostConfig.bios) { $Bios = $hostConfig.bios }
    # An extra seat (a VM streamed as "Seat2"...) asks the main PC's
    # LumaArcade who has it: "luma": "http://<main PC>:4500".
    if ($hostConfig.luma) { $LumaUrl = $hostConfig.luma }
}
if ($TestRoot) {
    $Root = "$TestRoot\profiles"; $EsDeDir = $TestRoot; $SnapshotRoot = "$TestRoot\snapshots"
    $E = "$TestRoot\Emulators"; $R = "$TestRoot\Roaming"; $Gamelists = "$TestRoot\gamelists"; $Bios = "$TestRoot\BIOS"
}
$LogFile = Join-Path $Root 'profiles.log'
$StateFile = Join-Path $Root 'state.json'
$StatFields = 'favorite', 'playcount', 'lastplayed', 'completed'
# Snapshots kept per player; the oldest go first. Automatic ones (-Auto)
# are counted separately.
$KeepSnapshots = 10
$KeepAutoSnapshots = 4

# slot => @(folder, seed). What a new player starts with:
#   $false              an empty folder (the emulators make fresh memory
#                       cards and save folders on their own)
#   $true               a copy of the shared folder: only Vita3K, whose
#                       folder holds the emulator's user profile it needs
#   'only:<sub path>'   just that part of the shared folder (Xenia: the
#                       gamer profile's Account file, not its saves); no
#                       folder at all if the shared one doesn't have it
#   'template:<folder>' a copy of a clean folder (xemu: a blank hard disk
#                       image); the slot is left shared until it exists
# So a new player never gets somebody else's progress (they used to start
# from a copy of everyone's pre-profile saves).
# melonDS, Flycast and ScummVM were pointed at these save folders
# (2026-10-01; their saves used to sit next to the ROMs or in the profile);
# EasyRPG and DOSBox Staging games are started through launchers that keep
# their saves here (host/launchers).
# Left shared on purpose: Azahar's sdmc/nand and Xenia's content hold
# installed games/DLC next to the saves, xemu's hdd is one disk image.
# Dolphin and Cemu keep their saves in their own folder when they're
# portable (the installer sets them up that way), else in the profile.
$DolphinUser = if (Test-Path "$E\Dolphin-x64\portable.txt") { "$E\Dolphin-x64\User" } else { "$R\Dolphin Emulator" }
$CemuUser = if (Test-Path "$E\cemu\portable") { "$E\cemu\portable" } else { "$R\Cemu" }
$Slots = [ordered]@{
    'RetroArch-saves'      = @("$E\RetroArch-Win64\saves", $false)
    'RetroArch-states'     = @("$E\RetroArch-Win64\states", $false)
    'Dolphin-GC'           = @("$DolphinUser\GC", $false)
    'Dolphin-Wii-title'    = @("$DolphinUser\Wii\title", $false)
    'Dolphin-StateSaves'   = @("$DolphinUser\StateSaves", $false)
    'PCSX2-memcards'       = @("$E\PCSX2-Qt\memcards", $false)
    'PCSX2-sstates'        = @("$E\PCSX2-Qt\sstates", $false)
    'DuckStation-memcards' = @("$E\duckstation\memcards", $false)
    'DuckStation-states'   = @("$E\duckstation\savestates", $false)
    'PPSSPP-SAVEDATA'      = @("$E\PPSSPP\memstick\PSP\SAVEDATA", $false)
    'PPSSPP-STATE'         = @("$E\PPSSPP\memstick\PSP\PPSSPP_STATE", $false)
    'RPCS3-savedata'       = @("$E\RPCS3\dev_hdd0\home\00000001\savedata", $false)
    'Cemu-save'            = @("$CemuUser\mlc01\usr\save", $false)
    'Eden-save'            = @("$E\eden\user\nand\user\save", $false)
    'Vita3K-user'          = @("$E\Vita3K\ux0\user", $true)
    'Supermodel-NVRAM'     = @("$E\Supermodel\NVRAM", $false)
    'Supermodel-Saves'     = @("$E\Supermodel\Saves", $false)
    'shadPS4-savedata'     = @("$E\shadPS4\user\savedata", $false)
    'melonDS-saves'        = @("$E\melonDS\saves", $false)
    'melonDS-states'       = @("$E\melonDS\states", $false)
    'Flycast-saves'        = @("$E\flycast\saves", $false)
    'Flycast-states'       = @("$E\flycast\states", $false)
    'ScummVM-saves'        = @("$E\scummvm\saves", $false)
    'Azahar-sdmc'          = @("$E\azahar\user\sdmc", $false)
    'EasyRPG-saves'        = @("$E\EasyRPG\saves", $false)
    'DOSBox-saves'         = @("$E\dosbox-staging\saves", $false)
    'xemu-hdd'             = @("$Bios\XBOXOG\hdd", "template:$Bios\XBOXOG\hdd-clean")
}
# Where a slot's put-away folders live, when not "<folder>.profiles".
$SlotStores = @{}
# Too big to copy into every snapshot (a 1 GB disk image).
$NoSnapshot = @('xemu-hdd')
# Xenia: each gamer profile's saves are in content\<its XUID>; DLC and
# title updates in content\0000000000000000 stay shared. Every profile
# folder is a slot of its own, put away outside content\ so Xenia never
# takes a put-away folder for a profile. Profiles made later belong to the
# player who made them (see Owner).
$XeniaContent = "$E\xenia_canary\content"
$XeniaStore = "$E\xenia_canary\content-profiles"
$DynamicSlots = @()
$xuids = @()
if (Test-Path $XeniaContent) { $xuids += Get-ChildItem $XeniaContent -Directory | Select-Object -ExpandProperty Name }
if (Test-Path $XeniaStore) { $xuids += Get-ChildItem $XeniaStore -Directory | Select-Object -ExpandProperty Name }
foreach ($xuid in ($xuids | Where-Object { $_ -match '^[0-9A-Fa-f]{16}$' -and $_ -ne '0000000000000000' } | Sort-Object -Unique)) {
    $slot = "Xenia-$xuid"
    $Slots[$slot] = @("$XeniaContent\$xuid", "only:FFFE07D1\00010000\$xuid\Account")
    $SlotStores[$slot] = "$XeniaStore\$xuid"
    $DynamicSlots += $slot
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
    $state.dynamicReady = [bool]$saved.dynamicReady
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
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    # A Xenia profile made since the last switch: the current player's.
    if ($DynamicSlots -contains $Slot -and $state.dynamicReady -and $state.current) { return $state.current }
    # Never switched: whatever is there is everyone's.
    return '_shared'
}

function Store([string]$Slot, [string]$Path) {
    if ($SlotStores.ContainsKey($Slot)) { return $SlotStores[$Slot] }
    return "$Path.profiles"
}

# Where this player's saves for a slot are right now (in use or put away).
function SlotDir([string]$Slot, [string]$Path, [string]$Id) {
    if ((Owner $Slot $Path) -eq $Id) { return $Path }
    return Join-Path (Store $Slot $Path) $Id
}

function Swap-Slot([string]$Slot, [string]$Path, $Seed, [string]$Id, [string]$Name) {
    $owner = Owner $Slot $Path
    if ($owner -eq $Id) { return }
    $store = Store $Slot $Path
    $mine = Join-Path $store $Id
    $template = if ($Seed -is [string] -and $Seed.StartsWith('template:')) { $Seed.Substring(9) } else { $null }
    # Nothing clean to start a new player from yet: it stays shared.
    if ($template -and -not (Test-Path -LiteralPath $template) -and -not (Test-Path -LiteralPath $mine)) { return }

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
            $only = if ($Seed -is [string] -and $Seed.StartsWith('only:')) { Join-Path $shared $Seed.Substring(5) } else { $null }
            if ($template) {
                Log "$Slot`: first time for $Name, starting from a clean copy"
                if (-not $DryRun) { Copy-Tree $template $Path }
            }
            elseif ($only) {
                if (-not (Test-Path -LiteralPath $only)) {
                    # Nothing to start from: leave it missing (no empty profile).
                    Log "$Slot`: first time for $Name, nothing to start from"
                    $state.slots[$Slot] = $Id
                    Save-State
                    return
                }
                Log "$Slot`: first time for $Name, starting with the profile only"
                if (-not $DryRun) {
                    $dest = Join-Path $Path $Seed.Substring(5)
                    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
                    Copy-Item -LiteralPath $only -Destination $dest -Recurse
                }
            }
            else {
                $copy = $Seed -eq $true -and (Test-Path -LiteralPath $shared)
                Log "$Slot`: first time for $Name$(if ($copy) { ', starting from the shared saves' })"
                if (-not $DryRun) {
                    if ($copy) { Copy-Tree $shared $Path }
                    else { New-Item -ItemType Directory -Force -Path $Path | Out-Null }
                }
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
        return (Invoke-RestMethod -Uri "$LumaUrl/api/profiles/current" -TimeoutSec 5 -UseBasicParsing).user
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
            auto   = [bool]($info -and $info.auto)
            slots  = $(if ($info) { $info.slots } else { @() })
            sizeKB = [math]::Round(((Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum) / 1KB)
        }
    })
}

function Take-Snapshot($Who, [string]$Text, [bool]$IsAuto = $false) {
    $id = "user-$($Who.id)"
    $name = Get-Date -Format 'yyyyMMdd-HHmmss'
    $dest = Join-Path (Snapshot-Dir $id) $name
    $copied = @()
    foreach ($slot in $Slots.Keys) {
        if ($NoSnapshot -contains $slot) { continue }
        $src = SlotDir $slot $Slots[$slot][0] $id
        if (-not (Test-Path -LiteralPath $src)) { continue }
        Copy-Tree $src (Join-Path $dest $slot)
        $copied += $slot
    }
    # Their ES-DE stats: live in the game lists if theirs are loaded.
    $stats = if ($state.current -eq $id) { Read-Stats } else { Read-StatsFile (Stats-File $id) }
    if ($stats) { Write-StatsFile (Join-Path $dest 'esde-stats.json') $stats }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    [ordered]@{ time = (Get-Date).ToString('o'); label = $Text; player = $Who.name; slots = $copied; auto = $IsAuto } |
        ConvertTo-Json | Set-Content (Join-Path $dest 'snapshot.json') -Encoding utf8
    # Prune automatic and own snapshots separately (the kind being taken).
    Get-ChildItem (Snapshot-Dir $id) -Directory | Where-Object {
        $meta = Join-Path $_.FullName 'snapshot.json'
        $wasAuto = (Test-Path $meta) -and [bool]((Get-Content $meta -Raw | ConvertFrom-Json).auto)
        $wasAuto -eq $IsAuto
    } | Sort-Object Name -Descending |
        Select-Object -Skip $(if ($IsAuto) { $KeepAutoSnapshots } else { $KeepSnapshots }) |
        ForEach-Object { Remove-Item $_.FullName -Recurse -Force }
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
        $src = Join-Path (Store $slot $path) $FromId
        if (Test-Path -LiteralPath $src) { $moves += , @($src, (Join-Path (Store $slot $path) $ToId)) }
    }
    foreach ($pair in @(@((Join-Path $Root $FromId), (Join-Path $Root $ToId)), @((Snapshot-Dir $FromId), (Snapshot-Dir $ToId)))) {
        if (Test-Path -LiteralPath $pair[0]) { $moves += , $pair }
    }
    foreach ($slot in $Slots.Keys) {
        $path = $Slots[$slot][0]
        if ((Owner $slot $path) -eq $ToId -or (Test-Path -LiteralPath (Join-Path (Store $slot $path) $ToId))) {
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
            'snapshot' { Reply @{ snapshot = (Take-Snapshot $who $Label $Auto.IsPresent) } }
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
    if (-not $state.dynamicReady) {
        $state.dynamicReady = $true
        Save-State
    }
}
catch {
    Log "Failed: $($_.Exception.Message)"
}
exit 0
