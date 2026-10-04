# Extra seats: more people playing at once, each on their own Windows - a
# Hyper-V virtual machine on this PC with a slice of the graphics card (GPU
# partitioning), its own Sunshine, ES-DE and emulators, reading the games
# from a read-only share of the games folder. Luma Arcade streams each one
# like another PC (server/src/web/seats.ts) and moves players' saves between
# them (saveSync.ts).
#
# Hyper-V needs an administrator and Luma Arcade runs as the games account,
# so this runs as SYSTEM: the scheduled task \LumaArcade\Seats starts it at
# boot (and Luma Arcade starts it with schtasks /run if it isn't running),
# and it serves requests the website drops in seats\requests\:
#   check                      look at the PC again (Hyper-V, GPU, ...)
#   prepare  { allowGpuPolicy, storage }
#                              turn on Hyper-V, allow GPU partitioning (Windows
#                              Server), make a network switch and the games
#                              share - once per PC; may need a restart
#   create   { name, iso, memoryGb, cpus, diskGb, gpuShare, clientCert, port }
#                              build a seat, start to finish (about an hour,
#                              most of it Windows installing itself)
#   repair   { name, clientCert, port }   run the seat's software steps again
#   remove   { name }          delete a seat's virtual machine and disk
#   start | stop | restart { name }
#   sync     { name, mode, playerId, playerName }   a player's saves in or
#                              out of a seat (answer in seats\responses\)
# and keeps seats\status.json up to date for the website (no secrets in it).
#
#   -Action serve    the loop above (the task)
#   -Action <other>  one job, started by the loop as its own process
#   -Action teardown the uninstaller: every seat Luma Arcade built, the games
#                    share and its account (Hyper-V itself stays)
#
# Seats' sign-ins (an admin account for this script, the games account that
# signs in by itself, Sunshine's web page) are in seats\<Name>\credentials.json,
# readable by administrators only.
param(
    [ValidateSet('serve', 'check', 'prepare', 'build', 'remove', 'power', 'sync', 'teardown')]
    [string]$Action = 'serve',
    [string]$Name = '',
    [string]$RequestFile = '',
    [string]$DataDir = 'C:\ProgramData\LumaArcade'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$SeatsDir = Join-Path $DataDir 'seats'
$RequestsDir = Join-Path $SeatsDir 'requests'
$ResponsesDir = Join-Path $SeatsDir 'responses'
$LogsDir = Join-Path $SeatsDir 'logs'
$StagingDir = Join-Path $SeatsDir 'staging'
$StatusFile = Join-Path $SeatsDir 'status.json'
$HostInfoFile = Join-Path $SeatsDir 'host-info.json'
$ShareFile = Join-Path $SeatsDir 'share.json'
$SetupDir = Join-Path $DataDir 'setup'
# Setup's "Extra seats" page: getting ready again once Hyper-V's restart is
# done, then the seats it asked for (installer/scripts/setup-seats.ps1).
$PreparePending = Join-Path $SeatsDir 'prepare-pending.json'
$AfterPrepareDir = Join-Path $SeatsDir 'after-prepare'
$SeatNamePattern = '^Seat\d{1,2}$'
$ShareName = 'LumaArcadeGames'
$ShareUser = 'lumaseatshare'
$SwitchName = 'Luma Arcade seats'
$FirewallGroup = 'Luma Arcade seats'
# Where a seat keeps a player's saves on the move (host/profiles.ps1 export/import).
$GuestSyncDir = 'C:\ProgramData\LumaArcade\sync'

# The steps of building a seat, in order, with what the settings page shows.
$Stages = [ordered]@{
    checks   = 'Checking this PC'
    answer   = "Writing Windows' answer file"
    vm       = 'Creating the virtual machine'
    windows  = 'Installing Windows (20-60 minutes)'
    driver   = 'Giving it the graphics driver'
    games    = 'Copying ES-DE and the emulators'
    software = 'Installing Sunshine and the helpers'
    pair     = 'Pairing it with Luma Arcade'
}

foreach ($dir in $SeatsDir, $RequestsDir, $ResponsesDir, $LogsDir, $StagingDir, $AfterPrepareDir) {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
}

# ------------------------------------------------------------------ helpers

function Write-Log([string]$Text, [string]$Seat = '') {
    $file = if ($Seat) { Join-Path $LogsDir "$Seat.log" } else { Join-Path $LogsDir 'manager.log' }
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Text"
    try {
        if ((Test-Path $file) -and (Get-Item $file).Length -gt 2MB) { Move-Item $file "$file.old" -Force }
        Add-Content -Path $file -Value $line -Encoding UTF8
    } catch { }
    Write-Output $line
}

function Save-Json($Object, [string]$Path) {
    $tmp = "$Path.tmp"
    $Object | ConvertTo-Json -Depth 8 | Set-Content -Path $tmp -Encoding UTF8
    Move-Item -Path $tmp -Destination $Path -Force
}

function Read-Json([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try { Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json } catch { $null }
}

function New-Password([int]$Length = 20) {
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'.ToCharArray()
    $bytes = New-Object byte[] $Length
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    # Upper, lower and a digit for Windows' complexity rules.
    'Lu7' + (-join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] }))
}

# Only administrators and SYSTEM: credentials and anything else secret.
function Protect-Path([string]$Path) {
    # (OI)(CI) only means something on a folder: on a file icacls refuses
    # it after removing the inherited rights, leaving nobody able to read it.
    $inherit = if (Test-Path -LiteralPath $Path -PathType Container) { '(OI)(CI)' } else { '' }
    & icacls.exe $Path /inheritance:r /grant:r "*S-1-5-32-544:${inherit}F" "*S-1-5-18:${inherit}F" /T /C /Q | Out-Null
    if ($LASTEXITCODE) { throw "Couldn't set the permissions of $Path" }
}

function Test-ReparsePoint([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
}

# Deletes a folder without following junctions inside it (rmdir /s
# removes a junction, not what it points at).
function Remove-Tree([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    if (Test-ReparsePoint $Path) { [IO.Directory]::Delete($Path); return }
    & cmd.exe /c rmdir /s /q "`"$Path`"" | Out-Null
}

function Seat-Dir([string]$Seat) { Join-Path $SeatsDir $Seat }
function Seat-File([string]$Seat) { Join-Path (Seat-Dir $Seat) 'seat.json' }
function Cred-File([string]$Seat) {
    $file = Join-Path (Seat-Dir $Seat) 'credentials.json'
    if (Test-Path $file) { return $file }
    # Seat2 on the PC this was first built on, set up by hand.
    $legacy = "E:\HyperV\$Seat\$($Seat.ToLower())-credentials.json"
    if (Test-Path $legacy) { return $legacy }
    $file
}

function Read-Seat([string]$Seat) { Read-Json (Seat-File $Seat) }
function Save-Seat($State) { Save-Json $State (Seat-File $State.name) }

function Set-Stage($State, [string]$Stage, [string]$Detail = '') {
    $State.stage = $Stage
    $State.detail = $Detail
    $State.updated = (Get-Date).ToString('o')
    Save-Seat $State
    $label = if ($Stages.Contains($Stage)) { $Stages[$Stage] } else { $Stage }
    Write-Log "$label$(if ($Detail) { ": $Detail" })" $State.name
}

function Complete-Stage($State, [string]$Stage) {
    $done = @($State.done) + $Stage | Select-Object -Unique
    $State.done = @($done)
    Save-Seat $State
}

function Get-SeatCredential([string]$Seat) {
    $c = Read-Json (Cred-File $Seat)
    if (-not $c) { throw "$Seat has no credentials file" }
    # New seats: a separate admin account. Seat2 (by hand): Arcade was the admin.
    $user = if ($c.adminUser) { $c.adminUser } else { $c.arcadeUser }
    $pass = if ($c.adminPassword) { $c.adminPassword } else { $c.arcadePassword }
    New-Object PSCredential("$Seat\$user", (ConvertTo-SecureString $pass -AsPlainText -Force))
}

function New-SeatSession([string]$Seat, [int]$TimeoutSec = 60) {
    $cred = Get-SeatCredential $Seat
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ($true) {
        try { return New-PSSession -VMName $Seat -Credential $cred -ErrorAction Stop }
        catch { if ((Get-Date) -gt $deadline) { throw "Can't reach $Seat's Windows: $($_.Exception.Message)" } }
        Start-Sleep 5
    }
}

# This PC's address on the home network (what the seats use to reach Luma
# Arcade and the games share).
function Get-HostAddress {
    $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object { $_.RouteMetric + $_.InterfaceMetric } | Select-Object -First 1
    if (-not $route) { return $null }
    (Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notmatch '^169\.254\.' } | Select-Object -First 1).IPAddress
}

function Get-VmAddress([string]$Seat) {
    $adapter = Get-VMNetworkAdapter -VMName $Seat -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $adapter) { return $null }
    @($adapter.IPAddresses) | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' -and $_ -notmatch '^169\.254\.' } | Select-Object -First 1
}

# host.json (installer/scripts/install-host.ps1): where ES-DE and the emulators are.
function Get-HostConfig { Read-Json (Join-Path $DataDir 'host.json') }

# The folder shared with the seats: the games folder (with the ROMs, BIOS
# files and usually ES-DE). Setup's games folder, else the drive ES-DE's
# emulators are on.
function Get-GamesRoot {
    $config = Get-HostConfig
    if ($config -and $config.gamesDir -and (Test-Path $config.gamesDir)) { return $config.gamesDir.TrimEnd('\') }
    if ($config -and $config.emulators) { return ([IO.Path]::GetPathRoot($config.emulators)).TrimEnd('\') }
    $null
}

# ------------------------------------------------------------------ this PC

function Get-PartitionableGpus {
    $list = @()
    foreach ($cmd in 'Get-VMHostPartitionableGpu', 'Get-VMPartitionableGpu') {
        if (Get-Command $cmd -ErrorAction SilentlyContinue) {
            try { $list = @(& $cmd -ErrorAction Stop); break } catch { }
        }
    }
    foreach ($gpu in $list) {
        $id = if ($gpu.Name -match 'VEN_([0-9A-F]{4})&DEV_([0-9A-F]{4})') { "VEN_$($Matches[1])&DEV_$($Matches[2])" } else { '' }
        $video = if ($id) { Get-CimInstance Win32_VideoController | Where-Object { $_.PNPDeviceID -like "*$id*" } | Select-Object -First 1 }
        [pscustomobject]@{
            path      = $gpu.Name
            name      = $(if ($video) { $video.Name } else { $id })
            vendor    = $(if ($id -match 'VEN_10DE') { 'NVIDIA' } elseif ($id -match 'VEN_1002') { 'AMD' } elseif ($id -match 'VEN_8086') { 'Intel' } else { '' })
            partitions = $gpu.TotalVF
        }
    }
}

function Get-HyperVState {
    $server = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').InstallationType -eq 'Server'
    try {
        if ($server) {
            $f = Get-WindowsFeature -Name Hyper-V
            if ($f.InstallState -eq 'InstallPending') { return 'restart' }
            if (-not $f.Installed) { return 'off' }
        } else {
            $f = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All
            if (-not $f) { return 'unavailable' }
            if ($f.State -eq 'EnablePending') { return 'restart' }
            if ($f.State -ne 'Enabled') { return 'off' }
        }
    } catch { return 'unavailable' }
    if (-not (Get-Service vmms -ErrorAction SilentlyContinue)) { return 'restart' }
    'on'
}

# Windows Server only lets "supported" (datacenter) GPUs be partitioned
# unless these two policies say otherwise (Hyper-V-VMMS-Admin event 34508).
$GpuPolicyKey = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\HyperV'
function Get-GpuPolicy {
    $server = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').InstallationType -eq 'Server'
    if (-not $server) { return 'not-needed' }
    $p = Get-ItemProperty $GpuPolicyKey -ErrorAction SilentlyContinue
    if ($p -and $p.RequireSecureDeviceAssignment -eq 0 -and $p.RequireSupportedDeviceAssignment -eq 0) { 'allowed' } else { 'blocked' }
}

function Get-ExternalSwitch {
    if (-not (Get-Command Get-VMSwitch -ErrorAction SilentlyContinue)) { return $null }
    $switches = @(Get-VMSwitch -SwitchType External -ErrorAction SilentlyContinue)
    ($switches | Where-Object Name -eq $SwitchName | Select-Object -First 1), ($switches | Select-Object -First 1) | Where-Object { $_ } | Select-Object -First 1
}

function Find-WindowsIsos {
    $places = @()
    foreach ($d in Get-ChildItem 'C:\Users' -Directory -ErrorAction SilentlyContinue) { $places += Join-Path $d.FullName 'Downloads' }
    foreach ($drive in Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue) {
        $places += $drive.Root
        $places += Get-ChildItem $drive.Root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'ISO|Hyper-?V' } | ForEach-Object { $_.FullName }
        $places += Get-ChildItem $drive.Root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'Hyper-?V' } |
            ForEach-Object { Get-ChildItem $_.FullName -Directory -ErrorAction SilentlyContinue | Where-Object Name -match 'ISO' } | ForEach-Object { $_.FullName }
    }
    $places | Select-Object -Unique | ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter *.iso -File -ErrorAction SilentlyContinue } |
        Where-Object { $_.Name -match 'win' -and $_.Name -notmatch 'server' -and $_.Length -gt 3GB } |
        Select-Object -First 10 | ForEach-Object { $_.FullName }
}

# What's ready on this PC, and what isn't (the settings page's checklist).
function Get-HostInfo([switch]$Fresh) {
    $cached = Read-Json $HostInfoFile
    if (-not $Fresh -and $cached -and ((Get-Date) - [datetime]$cached.checked).TotalMinutes -lt 10) { return $cached }
    $hyperV = Get-HyperVState
    $gpus = if ($hyperV -eq 'on') { @(Get-PartitionableGpus) } else { @() }
    $switch = if ($hyperV -eq 'on') { Get-ExternalSwitch } else { $null }
    $share = Get-SmbShare -Name $ShareName -ErrorAction SilentlyContinue
    $os = Get-CimInstance Win32_OperatingSystem
    $vmHost = if ($hyperV -eq 'on') { Get-VMHost -ErrorAction SilentlyContinue }
    $storage = if ($vmHost) { $vmHost.VirtualHardDiskPath } else { '' }
    $storageFree = 0
    if ($storage) {
        $root = [IO.Path]::GetPathRoot($storage)
        $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($root.TrimEnd('\'))'" -ErrorAction SilentlyContinue
        if ($disk) { $storageFree = [math]::Round($disk.FreeSpace / 1GB) }
    }
    $info = [ordered]@{
        checked      = (Get-Date).ToString('o')
        edition      = $os.Caption
        server       = ((Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').InstallationType -eq 'Server')
        hyperV       = $hyperV
        gpuPolicy    = Get-GpuPolicy
        gpus         = @($gpus)
        switch       = $(if ($switch) { $switch.Name } else { $null })
        share        = $(if ($share) { "\\$env:COMPUTERNAME\$ShareName" } else { $null })
        sharePath    = $(if ($share) { $share.Path } else { $null })
        gamesRoot    = Get-GamesRoot
        hostAddress  = Get-HostAddress
        memoryGb     = [math]::Round($os.TotalVisibleMemorySize / 1MB)
        freeMemoryGb = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
        cpus         = [Environment]::ProcessorCount
        storage      = $storage
        storageFreeGb = $storageFree
        isos         = @(Find-WindowsIsos)
        setupScripts = (Test-Path (Join-Path $SetupDir 'install-sunshine.ps1'))
    }
    $problems = @()
    switch ($hyperV) {
        'unavailable' { $problems += "This Windows can't run Hyper-V (Windows Home doesn't have it): extra seats need Windows Pro, Enterprise or Server." }
        'off' { $problems += 'Hyper-V is off.' }
        'restart' { $problems += 'Hyper-V is turned on, but this PC has to restart before it works.' }
    }
    if ($hyperV -eq 'on' -and -not $gpus) { $problems += "No graphics card here can be partitioned. GPU partitioning needs a recent NVIDIA, AMD or Intel driver, and a Windows 10/11 Pro or Windows Server host." }
    if ($info.gpuPolicy -eq 'blocked') { $problems += 'Windows Server only partitions datacenter graphics cards until two Hyper-V policies allow others.' }
    if ($hyperV -eq 'on' -and -not $switch) { $problems += 'There is no Hyper-V network switch connected to the home network.' }
    if (-not $share) { $problems += 'The games folder isn''t shared with the seats yet.' }
    if (-not $info.setupScripts) { $problems += 'Luma Arcade''s setup scripts aren''t in C:\ProgramData\LumaArcade\setup: run Setup again.' }
    $info.problems = @($problems)
    $info.ready = -not $problems
    Save-Json $info $HostInfoFile
    Read-Json $HostInfoFile
}

# ------------------------------------------------------------------ status

function Get-SeatNames {
    $names = @()
    $names += Get-ChildItem $SeatsDir -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $SeatNamePattern } | ForEach-Object Name
    if (Get-Command Get-VM -ErrorAction SilentlyContinue) {
        $names += Get-VM -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^Seat\s*\d+$' } | ForEach-Object Name
    }
    $names | Select-Object -Unique | Sort-Object { [int]($_ -replace '\D', '') }
}

function Get-SeatStatus([string]$Seat, $Jobs) {
    $state = Read-Seat $Seat
    $vm = if (Get-Command Get-VM -ErrorAction SilentlyContinue) { Get-VM -Name $Seat -ErrorAction SilentlyContinue }
    $job = $Jobs.Values | Where-Object { $_.Name -eq $Seat -and -not $_.Process.HasExited } | Select-Object -First 1
    $done = @(if ($state) { $state.done })
    $stage = if ($state) { $state.stage } else { 'ready' }
    $finished = [bool]($state -and $state.finished) -or (-not $state -and $vm)
    [ordered]@{
        name       = $Seat
        managed    = [bool]$state
        vm         = $(if ($vm) { [string]$vm.State } else { $null })
        uptimeMin  = $(if ($vm) { [math]::Round($vm.Uptime.TotalMinutes) } else { 0 })
        address    = $(if ($vm -and $vm.State -eq 'Running') { Get-VmAddress $Seat } elseif ($state) { $state.address } else { $null })
        memoryGb   = $(if ($vm) { [math]::Round($vm.MemoryStartup / 1GB) } elseif ($state) { $state.memoryGb } else { 0 })
        cpus       = $(if ($vm) { $vm.ProcessorCount } elseif ($state) { $state.cpus } else { 0 })
        gpuShare   = $(if ($state) { $state.gpuShare } else { $null })
        stage      = $stage
        stageLabel = $(if ($Stages.Contains($stage)) { $Stages[$stage] } else { $stage })
        detail     = $(if ($state) { $state.detail } else { '' })
        step       = $(if ($Stages.Contains($stage)) { @($Stages.Keys).IndexOf($stage) + 1 } else { 0 })
        steps      = $Stages.Count
        done       = $done
        error      = $(if ($state) { $state.error } else { $null })
        finished   = $finished
        working    = $(if ($job) { $job.Kind } else { $null })
        created    = $(if ($state) { $state.created } else { $null })
        serverCert = $(if ($state -and $state.serverCert) { $state.serverCert } else { $null })
        httpPort   = 47989
    }
}

function Write-Status($Jobs, [switch]$FreshHost) {
    $info = Get-HostInfo -Fresh:$FreshHost
    $seats = @(Get-SeatNames | ForEach-Object { Get-SeatStatus $_ $Jobs })
    $running = @($Jobs.Values | Where-Object { -not $_.Process.HasExited } | ForEach-Object { [ordered]@{ kind = $_.Kind; name = $_.Name; started = $_.Started } })
    Save-Json ([ordered]@{
        updated = (Get-Date).ToString('o')
        pid     = $PID
        host    = $info
        seats   = $seats
        jobs    = $running
    }) $StatusFile
}

# ------------------------------------------------------------------ prepare

function Invoke-Prepare($Request) {
    $server = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').InstallationType -eq 'Server'
    $restart = $false
    $hyperV = Get-HyperVState
    if ($hyperV -eq 'unavailable') { throw "This Windows can't run Hyper-V: extra seats need Windows Pro, Enterprise or Server." }
    if ($hyperV -eq 'off') {
        Write-Log 'Turning on Hyper-V'
        if ($server) { Install-WindowsFeature -Name Hyper-V -IncludeManagementTools | Out-Null }
        else { Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All -NoRestart | Out-Null }
        $restart = $true
    } elseif ($hyperV -eq 'restart') { $restart = $true }

    if ($server -and $Request.allowGpuPolicy) {
        Write-Log 'Allowing GPU partitioning of this graphics card (RequireSecureDeviceAssignment / RequireSupportedDeviceAssignment = 0)'
        if (-not (Test-Path $GpuPolicyKey)) { New-Item -Path $GpuPolicyKey -Force | Out-Null }
        Set-ItemProperty $GpuPolicyKey -Name RequireSecureDeviceAssignment -Value 0 -Type DWord
        Set-ItemProperty $GpuPolicyKey -Name RequireSupportedDeviceAssignment -Value 0 -Type DWord
    }

    if (-not $restart) {
        if (-not (Get-ExternalSwitch)) {
            # The adapter this PC reaches the internet through.
            $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object { $_.RouteMetric + $_.InterfaceMetric } | Select-Object -First 1
            $nic = Get-NetAdapter -InterfaceIndex $route.InterfaceIndex
            if ($nic.InterfaceDescription -match 'Hyper-V') { throw "The home network already goes through a Hyper-V switch that isn't External: give it a physical network adapter" }
            Write-Log "Creating the network switch '$SwitchName' on $($nic.Name) (the network drops for a few seconds)"
            New-VMSwitch -Name $SwitchName -NetAdapterName $nic.Name -AllowManagementOS $true | Out-Null
        }
        if ($Request.storage) {
            New-Item -ItemType Directory -Force $Request.storage | Out-Null
            Set-VMHost -VirtualHardDiskPath $Request.storage -VirtualMachinePath $Request.storage
        }
    }

    New-GamesShare
    # The seats ask Luma Arcade who's playing (their per-player saves).
    $port = [int]$Request.port
    if ($port -gt 0) {
        Get-NetFirewallRule -DisplayName "$FirewallGroup`: Luma Arcade" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
        New-NetFirewallRule -DisplayName "$FirewallGroup`: Luma Arcade" -Group $FirewallGroup -Direction Inbound -Protocol TCP -LocalPort $port -RemoteAddress LocalSubnet -Action Allow | Out-Null
    }
    if ($restart) {
        # Carries on by itself after the restart (the task starts at boot).
        Save-Json $Request $PreparePending
        Protect-Path $PreparePending
        Write-Log 'Restart this PC to finish turning on Hyper-V: getting ready carries on by itself afterwards.'
    } else {
        Remove-Item -LiteralPath $PreparePending -Force -ErrorAction SilentlyContinue
        # Seats Setup asked for, now that the PC is ready for them.
        foreach ($f in Get-ChildItem $AfterPrepareDir -Filter *.json -File -ErrorAction SilentlyContinue | Sort-Object Name) {
            Move-Item -LiteralPath $f.FullName -Destination (Join-Path $RequestsDir $f.Name) -Force
            Write-Log "Queued $($f.BaseName) from Setup"
        }
    }
    @{ restart = $restart }
}

# A read-only share of the games folder for a local account that can't
# sign in at the PC: the seats read ROMs, BIOS files and media through it.
function New-GamesShare {
    $root = Get-GamesRoot
    if (-not $root) { throw "Couldn't tell where the games folder is (no host.json): run Setup again" }
    $path = if ($root -match '^[A-Za-z]:$') { "$root\" } else { $root }
    $saved = Read-Json $ShareFile
    $password = if ($saved -and $saved.password) { $saved.password } else { New-Password }
    $secure = ConvertTo-SecureString $password -AsPlainText -Force
    if (Get-LocalUser -Name $ShareUser -ErrorAction SilentlyContinue) {
        Set-LocalUser -Name $ShareUser -Password $secure -PasswordNeverExpires $true
    } else {
        Write-Log "Creating the account $ShareUser (reads the games share, can't sign in)"
        New-LocalUser -Name $ShareUser -Password $secure -PasswordNeverExpires -UserMayNotChangePassword -FullName 'Luma Arcade seats' -Description 'Luma Arcade seats: read-only access to the games folder' | Out-Null
    }
    # Not allowed to sign in at the PC or over Remote Desktop.
    $tmp = [IO.Path]::GetTempFileName()
    & secedit.exe /export /cfg $tmp /areas USER_RIGHTS | Out-Null
    $sid = (Get-LocalUser $ShareUser).SID.Value
    $cfg = Get-Content $tmp
    foreach ($right in 'SeDenyInteractiveLogonRight', 'SeDenyRemoteInteractiveLogonRight') {
        $line = $cfg | Where-Object { $_ -like "$right*" }
        if ($line) { if ($line -notmatch [regex]::Escape($sid)) { $cfg = $cfg -replace "^$right = (.*)$", "$right = `$1,*$sid" } }
        else { $cfg = $cfg -replace '^\[Privilege Rights\]$', "[Privilege Rights]`r`n$right = *$sid" }
    }
    $cfg | Set-Content $tmp -Encoding Unicode
    & secedit.exe /configure /db (Join-Path $env:TEMP 'lumaseatshare.sdb') /cfg $tmp /areas USER_RIGHTS | Out-Null
    Remove-Item $tmp -ErrorAction SilentlyContinue

    $share = Get-SmbShare -Name $ShareName -ErrorAction SilentlyContinue
    if ($share -and $share.Path.TrimEnd('\') -ne $path.TrimEnd('\')) { Remove-SmbShare -Name $ShareName -Force; $share = $null }
    if (-not $share) {
        Write-Log "Sharing $path read-only with the seats (\\$env:COMPUTERNAME\$ShareName)"
        New-SmbShare -Name $ShareName -Path $path -ReadAccess $ShareUser -Description 'Luma Arcade seats: games (read-only)' | Out-Null
    }
    # NTFS read for the account too (a drive root may not grant Users).
    & icacls.exe $path /grant "${ShareUser}:(OI)(CI)RX" /C /Q | Out-Null
    Get-NetFirewallRule -DisplayName "$FirewallGroup`: games share" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName "$FirewallGroup`: games share" -Group $FirewallGroup -Direction Inbound -Protocol TCP -LocalPort 445 -RemoteAddress LocalSubnet -Action Allow | Out-Null
    Save-Json ([ordered]@{ user = $ShareUser; password = $password; name = $ShareName; path = $path }) $ShareFile
    Protect-Path $ShareFile
}

# ------------------------------------------------------------------ build

# Picks the Windows edition to install from the ISO: Pro, else the first
# Windows 10/11 one there is.
function Get-IsoImage([string]$Iso) {
    $mount = Mount-DiskImage -ImagePath $Iso -PassThru
    try {
        $letter = ($mount | Get-Volume).DriveLetter
        $wim = @("$letter`:\sources\install.wim", "$letter`:\sources\install.esd") | Where-Object { Test-Path $_ } | Select-Object -First 1
        if (-not $wim) { throw "$Iso isn't a Windows installation disc (no sources\install.wim)" }
        $images = @(Get-WindowsImage -ImagePath $wim)
        $pick = ($images | Where-Object { $_.ImageName -match '^Windows 1[01] Pro$' } | Select-Object -First 1)
        if (-not $pick) { $pick = $images | Where-Object { $_.ImageName -match '^Windows 1[01]' -and $_.ImageName -notmatch ' N$|Home|S$' } | Select-Object -First 1 }
        if (-not $pick) { throw "$Iso has no Windows 10 or 11 Pro/Enterprise/Education edition (found: $(($images.ImageName) -join ', ')). A seat needs desktop Windows, not Home or Server." }
        $detail = Get-WindowsImage -ImagePath $wim -Index $pick.ImageIndex
        [pscustomobject]@{ Index = $pick.ImageIndex; Name = $pick.ImageName; Language = @($detail.Languages)[$detail.DefaultLanguageIndex] }
    } finally { Dismount-DiskImage -ImagePath $Iso | Out-Null }
}

# Microsoft's published generic setup keys: they install, they don't activate.
$GenericKeys = @{ 'Pro' = 'W269N-WFGWX-YVC9B-4J6C9-T83GX'; 'Enterprise' = 'NPPR9-FWDCX-D2C8J-H872K-2YT43'; 'Education' = 'NW6C2-QMPVW-D7KKK-3GKT6-VCFB2' }

function New-AnswerIso($State, $Cred, $Image) {
    $esc = { param($s) [Security.SecurityElement]::Escape($s) }
    $culture = (Get-Culture).Name
    $ui = if ($Image.Language) { $Image.Language } else { 'en-US' }
    $tz = (Get-TimeZone).Id
    $edition = ($GenericKeys.Keys | Where-Object { $Image.Name -match " $_$" } | Select-Object -First 1)
    $key = if ($edition) { "<ProductKey><Key>$($GenericKeys[$edition])</Key><WillShowUI>Never</WillShowUI></ProductKey>" } else { '' }
    $computer = $State.name.ToUpper()
    $adminUser = & $esc $Cred.adminUser; $adminPass = & $esc $Cred.adminPassword
    $arcadeUser = & $esc $Cred.arcadeUser; $arcadePass = & $esc $Cred.arcadePassword
    $intl = @"
      <InputLocale>$culture</InputLocale>
      <SystemLocale>$culture</SystemLocale>
      <UILanguage>$ui</UILanguage>
      <UserLocale>$culture</UserLocale>
"@
    $xml = @"
<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
  <settings pass="windowsPE">
    <component name="Microsoft-Windows-International-Core-WinPE" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <SetupUILanguage><UILanguage>$ui</UILanguage></SetupUILanguage>
$intl    </component>
    <component name="Microsoft-Windows-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <DiskConfiguration>
        <Disk wcm:action="add">
          <DiskID>0</DiskID>
          <WillWipeDisk>true</WillWipeDisk>
          <CreatePartitions>
            <CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>300</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Format>FAT32</Format><Label>System</Label></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>3</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition>
          </ModifyPartitions>
        </Disk>
      </DiskConfiguration>
      <ImageInstall>
        <OSImage>
          <InstallFrom><MetaData wcm:action="add"><Key>/IMAGE/INDEX</Key><Value>$($Image.Index)</Value></MetaData></InstallFrom>
          <InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo>
        </OSImage>
      </ImageInstall>
      <UserData>
        $key
        <AcceptEula>true</AcceptEula>
      </UserData>
    </component>
  </settings>
  <settings pass="specialize">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <ComputerName>$computer</ComputerName>
      <TimeZone>$tz</TimeZone>
    </component>
    <component name="Microsoft-Windows-Deployment" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <RunSynchronous>
        <RunSynchronousCommand wcm:action="add"><Order>1</Order><Path>reg add HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\OOBE /v BypassNRO /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add"><Order>2</Order><Path>reg add HKLM\SYSTEM\CurrentControlSet\Control\BitLocker /v PreventDeviceEncryption /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand>
      </RunSynchronous>
    </component>
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-International-Core" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
$intl    </component>
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <ProtectYourPC>3</ProtectYourPC>
      </OOBE>
      <UserAccounts>
        <LocalAccounts>
          <LocalAccount wcm:action="add">
            <Name>$adminUser</Name>
            <Group>Administrators</Group>
            <Password><Value>$adminPass</Value><PlainText>true</PlainText></Password>
          </LocalAccount>
          <LocalAccount wcm:action="add">
            <Name>$arcadeUser</Name>
            <Group>Users</Group>
            <Password><Value>$arcadePass</Value><PlainText>true</PlainText></Password>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>
      <AutoLogon>
        <Enabled>true</Enabled>
        <Username>$arcadeUser</Username>
        <Password><Value>$arcadePass</Value><PlainText>true</PlainText></Password>
        <LogonCount>999999</LogonCount>
      </AutoLogon>
      <FirstLogonCommands>
        <SynchronousCommand wcm:action="add"><Order>1</Order><CommandLine>powercfg /change standby-timeout-ac 0</CommandLine></SynchronousCommand>
        <SynchronousCommand wcm:action="add"><Order>2</Order><CommandLine>powercfg /change monitor-timeout-ac 0</CommandLine></SynchronousCommand>
        <SynchronousCommand wcm:action="add"><Order>3</Order><CommandLine>powercfg /change hibernate-timeout-ac 0</CommandLine></SynchronousCommand>
      </FirstLogonCommands>
    </component>
  </settings>
</unattend>
"@
    $stage = Join-Path $env:TEMP "$($State.name)-unattend"
    Remove-Tree $stage
    New-Item -ItemType Directory $stage | Out-Null
    [IO.File]::WriteAllText((Join-Path $stage 'autounattend.xml'), $xml, (New-Object Text.UTF8Encoding $false))
    if (-not ('LumaIsoWriter' -as [type])) {
        Add-Type -TypeDefinition @'
using System; using System.IO; using System.Runtime.InteropServices; using System.Runtime.InteropServices.ComTypes;
public static class LumaIsoWriter {
  public static void Save(object stream, string path) {
    IStream s = (IStream)stream; var buf = new byte[65536]; IntPtr read = Marshal.AllocHGlobal(4);
    using (var fs = File.Create(path)) {
      while (true) { s.Read(buf, buf.Length, read); int n = Marshal.ReadInt32(read); if (n <= 0) break; fs.Write(buf, 0, n); }
    }
    Marshal.FreeHGlobal(read);
  }
}
'@
    }
    $image = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
    $image.FileSystemsToCreate = 3   # ISO9660 + Joliet
    $image.VolumeName = 'LUMASEAT'
    $image.Root.AddTree($stage, $false)
    $iso = Join-Path (Seat-Dir $State.name) 'unattend.iso'
    [LumaIsoWriter]::Save($image.CreateResultImage().ImageStream, $iso)
    Remove-Tree $stage
    $iso
}

function Set-GpuPartition([string]$Seat, [string]$GpuPath, [double]$Share) {
    Get-VMGpuPartitionAdapter -VMName $Seat -ErrorAction SilentlyContinue | Remove-VMGpuPartitionAdapter
    Add-VMGpuPartitionAdapter -VMName $Seat -InstancePath $GpuPath
    # VRAM, decode and compute are out of 1e9; encode out of 2^64.
    $part = [uint64][math]::Floor(1000000000 * $Share)
    $encode = [uint64]([decimal]18446744073709551615 * [decimal]$Share)
    Set-VMGpuPartitionAdapter -VMName $Seat `
        -MinPartitionVRAM $part -MaxPartitionVRAM $part -OptimalPartitionVRAM $part `
        -MinPartitionEncode $encode -MaxPartitionEncode $encode -OptimalPartitionEncode $encode `
        -MinPartitionDecode $part -MaxPartitionDecode $part -OptimalPartitionDecode $part `
        -MinPartitionCompute $part -MaxPartitionCompute $part -OptimalPartitionCompute $part
}

function New-SeatVm($State, [string]$AnswerIso) {
    $seat = $State.name
    $existing = Get-VM -Name $seat -ErrorAction SilentlyContinue
    if ($existing) {
        # Made by an earlier try of this build (it stopped before noting it).
        if ($State.vmDir -and $existing.Path.TrimEnd('\') -eq $State.vmDir.TrimEnd('\')) { Write-Log "$seat's virtual machine is already there" $seat; return }
        throw "There's already a virtual machine called $seat that Luma Arcade didn't make"
    }
    $switch = Get-ExternalSwitch
    if (-not $switch) { throw 'No Hyper-V network switch connected to the home network: get this PC ready first' }
    $root = if ($State.storage) { $State.storage } else { (Get-VMHost).VirtualHardDiskPath }
    $dir = Join-Path $root "Luma Arcade $seat"
    $vhd = Join-Path $dir "$seat.vhdx"
    $State.vmDir = $dir
    Save-Seat $State
    New-Item -ItemType Directory -Force $dir | Out-Null
    New-VM -Name $seat -Generation 2 -MemoryStartupBytes ([int64]$State.memoryGb * 1GB) -NewVHDPath $vhd -NewVHDSizeBytes ([int64]$State.diskGb * 1GB) -SwitchName $switch.Name -Path $dir | Out-Null
    # GPU partitioning: static memory, no checkpoints, room for the GPU's
    # memory-mapped I/O. A clean shutdown when the PC stops (a hard stop can
    # lose Windows' last registry writes).
    Set-VM -Name $seat -ProcessorCount $State.cpus -StaticMemory -CheckpointType Disabled -AutomaticStartAction Start -AutomaticStopAction ShutDown `
        -GuestControlledCacheTypes $true -LowMemoryMappedIoSpace 1GB -HighMemoryMappedIoSpace 32GB
    # Windows 11 wants a TPM and Secure Boot.
    Set-VMKeyProtector -VMName $seat -NewLocalKeyProtector
    Enable-VMTPM -VMName $seat
    Set-VMFirmware -VMName $seat -EnableSecureBoot On -SecureBootTemplate 'MicrosoftWindows'
    # Sunshine streams the VM's own screen (a virtual display driver can't
    # show Vulkan games in a partitioned VM): 1080p.
    Set-VMVideo -VMName $seat -ResolutionType Single -HorizontalResolution 1920 -VerticalResolution 1080 -ErrorAction SilentlyContinue
    Enable-VMIntegrationService -VMName $seat -Name 'Guest Service Interface' -ErrorAction SilentlyContinue
    Add-VMDvdDrive -VMName $seat -Path $State.iso
    Add-VMDvdDrive -VMName $seat -Path $AnswerIso
    $dvd = Get-VMDvdDrive -VMName $seat | Where-Object Path -eq $State.iso
    Set-VMFirmware -VMName $seat -FirstBootDevice $dvd
    Set-GpuPartition $seat $State.gpu $State.gpuShare
    Write-Log "Created: $($State.cpus) processors, $($State.memoryGb) GB memory, $($State.diskGb) GB disk at $vhd, $([math]::Round($State.gpuShare * 100))% of $($State.gpuName)" $seat
}

# Waits for Windows Setup to finish and the games account to sign in.
function Wait-Windows($State) {
    $seat = $State.name
    if ((Get-VM -Name $seat).State -ne 'Running') { Start-VM -Name $seat }
    $cred = Get-SeatCredential $seat
    $deadline = (Get-Date).AddHours(3)
    $started = Get-Date
    while ($true) {
        try {
            $ready = Invoke-Command -VMName $seat -Credential $cred -ErrorAction Stop -ArgumentList $State.arcadeUser -ScriptBlock {
                param($user)
                [bool](Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | Where-Object { (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User -eq $user })
            }
            if ($ready) { break }
            Set-Stage $State 'windows' 'Windows is installed; waiting for the games account to sign in'
        } catch {
            $min = [math]::Round(((Get-Date) - $started).TotalMinutes)
            if ($min -gt 0 -and $min % 5 -eq 0) { Set-Stage $State 'windows' "$min minutes so far" }
        }
        if ((Get-Date) -gt $deadline) { throw "Windows didn't finish installing in 3 hours. Open $seat in Hyper-V Manager to see where it's stuck." }
        Start-Sleep 30
    }
    # Setup is done with the discs.
    Get-VMDvdDrive -VMName $seat | Set-VMDvdDrive -Path $null -ErrorAction SilentlyContinue
}

# A clean restart inside Windows (a hard reset loses its last registry
# writes - autologon kept vanishing that way), then waits for the sign-in.
function Restart-Seat($State) {
    $seat = $State.name
    $cred = Get-SeatCredential $seat
    Invoke-Command -VMName $seat -Credential $cred -ScriptBlock { & shutdown.exe /r /t 0 /f } -ErrorAction SilentlyContinue
    Start-Sleep 20
    $deadline = (Get-Date).AddMinutes(10)
    while ((Get-Date) -lt $deadline) {
        try {
            $up = Invoke-Command -VMName $seat -Credential $cred -ErrorAction Stop -ScriptBlock {
                [bool](Get-Process explorer -ErrorAction SilentlyContinue)
            }
            if ($up) { Start-Sleep 10; return }
        } catch { }
        Start-Sleep 10
    }
    throw "$seat didn't come back after restarting"
}

# The host's graphics driver, copied into the seat: a partitioned GPU uses
# the host's driver, which the seat finds in System32\HostDriverStore.
function Copy-GpuDriver($State) {
    $seat = $State.name
    $id = if ($State.gpu -match 'VEN_([0-9A-F]{4})&DEV_([0-9A-F]{4})') { "VEN_$($Matches[1])&DEV_$($Matches[2])" } else { throw "Can't tell which graphics card $($State.gpu) is" }
    $drivers = @(Get-WmiObject Win32_PnPSignedDriver | Where-Object { $_.DeviceID -like "PCI\$id*" -and $_.DeviceClass -eq 'DISPLAY' })
    if (-not $drivers) { throw "No driver found for $($State.gpuName)" }
    $session = New-SeatSession $seat
    try {
        $folders = @{}
        $files = @()
        foreach ($d in $drivers) {
            $antecedent = 'Win32_PnPSignedDriver.DeviceID="' + ($d.DeviceID -replace '\\', '\\') + '"'
            foreach ($f in Get-WmiObject Win32_PnPSignedDriverCIMDataFile | Where-Object { $_.Antecedent.EndsWith($antecedent, [StringComparison]::OrdinalIgnoreCase) }) {
                $path = ($f.Dependent.Split('=', 2)[1] -replace '\\\\', '\').Trim('"')
                if ($path -like '*\System32\DriverStore\FileRepository\*') {
                    $parts = $path.Split('\')
                    $at = [array]::IndexOf(($parts | ForEach-Object { $_.ToLower() }), 'filerepository')
                    $folders[($parts[0..($at + 1)] -join '\')] = $parts[$at + 1]
                } else { $files += $path }
            }
        }
        foreach ($folder in $folders.Keys) {
            $dest = "C:\Windows\System32\HostDriverStore\FileRepository\$($folders[$folder])"
            Set-Stage $State 'driver' "Copying $($folders[$folder])"
            Invoke-Command -Session $session -ScriptBlock { param($d) if (Test-Path $d) { Remove-Item $d -Recurse -Force }; New-Item -ItemType Directory -Force (Split-Path $d) | Out-Null } -ArgumentList $dest
            Copy-Item -ToSession $session -Path $folder -Destination $dest -Recurse -Force
        }
        foreach ($file in $files | Select-Object -Unique) {
            if (-not (Test-Path -LiteralPath $file)) { continue }
            $dest = $file -replace '^[A-Za-z]:', 'C:'
            try {
                Invoke-Command -Session $session -ScriptBlock { param($d) New-Item -ItemType Directory -Force (Split-Path $d) | Out-Null } -ArgumentList $dest
                Copy-Item -ToSession $session -LiteralPath $file -Destination $dest -Force
            } catch { Write-Log "Skipped $file ($($_.Exception.Message))" $seat }
        }
        Write-Log "Copied $($folders.Count) driver folder(s) and $(@($files | Select-Object -Unique).Count) file(s)" $seat
    } finally { Remove-PSSession $session }
    Restart-Seat $State
    $session = New-SeatSession $seat
    try {
        $gpu = Invoke-Command -Session $session -ScriptBlock {
            Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notmatch 'Microsoft|Hyper-V' } | Select-Object -First 1 Name, Status
        }
    } finally { Remove-PSSession $session }
    if (-not $gpu -or $gpu.Status -ne 'OK') { throw "The graphics card doesn't work inside $seat after copying the driver$(if ($gpu) { " ($($gpu.Name): $($gpu.Status))" })" }
    Write-Log "Graphics inside the seat: $($gpu.Name)" $seat
}

# What seat-guest.ps1 needs to know, from this PC.
function Get-GuestPlan($State) {
    $config = Get-HostConfig
    $share = Read-Json $ShareFile
    if (-not $share) { throw 'The games share is missing: get this PC ready again' }
    $gamesRoot = (Get-GamesRoot).TrimEnd('\')
    $hostAddress = Get-HostAddress
    # The share becomes the same drive letter in the seat when the games are
    # a whole drive other than C: (every path stays the same), else G:.
    $letter = if ($gamesRoot -match '^([D-Zd-z]):$') { $Matches[1].ToUpper() } else { 'G' }
    $guestGames = "$letter`:"
    $hostSunshine = Join-Path $env:ProgramFiles 'Sunshine\config\sunshine.conf'
    $conf = if (Test-Path $hostSunshine) { @(Get-Content $hostSunshine | Where-Object { $_ -match '^\s*(gamepad|nvenc_preset|nvenc_twopass|channels|encoder|hevc_mode|av1_mode|amd_quality|qsv_preset)\s*=' }) } else { @() }

    # Where ES-DE, its settings, the ROMs and the media are on this PC.
    $esDeDir = ([string]$config.esDeDir).TrimEnd('\')
    if (-not $esDeDir -or -not (Test-Path (Join-Path $esDeDir 'ES-DE.exe'))) { throw "ES-DE isn't installed on this PC (host.json esDeDir: '$esDeDir'): a seat copies the main PC's" }
    $data = if ($config.gamelists) { (Split-Path $config.gamelists).TrimEnd('\') } else { Join-Path $esDeDir 'ES-DE' }
    $portable = Test-Path (Join-Path $esDeDir 'portable.txt')
    $profile = if ($portable) { '' } else { Split-Path $data }
    $rom = ''; $media = ''
    $settings = Join-Path $data 'settings\es_settings.xml'
    if (Test-Path $settings) {
        $text = Get-Content -Raw $settings
        if ($text -match 'name="ROMDirectory" value="([^"]*)"') { $rom = $Matches[1] }
        if ($text -match 'name="MediaDirectory" value="([^"]*)"') { $media = $Matches[1] }
    }
    $resolve = { param($p) ($p -replace '%ESPATH%', $esDeDir -replace '%HOMEPATH%', $profile -replace '/', '\').TrimEnd('\') }
    $rom = if ($rom) { & $resolve $rom } elseif ($portable) { Join-Path $esDeDir 'ROMs' } else { Join-Path $profile 'ROMs' }
    $media = if ($media) { & $resolve $media } else { Join-Path $data 'downloaded_media' }
    $emulators = ([string]$config.emulators).TrimEnd('\')

    $under = { param($path, $root) $path -and $root -and ($path.TrimEnd('\') + '\').StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) }
    $rel = { param($path) $path.Substring($gamesRoot.Length).TrimStart('\') }
    $onShare = { param($path) if (& $under $path $gamesRoot) { $guestGames + '\' + (& $rel $path) } else { $null } }

    $guestRom = & $onShare $rom
    if (-not $guestRom) { throw "ES-DE's ROMs folder ($rom) isn't inside the games folder ($gamesRoot), so the seats can't see it. Move the ROMs into the games folder (and set ES-DE's ROM directory) first." }
    $guestMedia = & $onShare $media
    $dataDest = if (& $under $data $esDeDir) { Join-Path 'C:\ES-DE' $data.Substring($esDeDir.Length).TrimStart('\') } else { "C:\Users\$($State.arcadeUser)\ES-DE" }
    $emuDest = if (-not $emulators -or (& $under $emulators $esDeDir)) { $null } else { 'C:\ES-DE\Emulators' }

    # Copied over the share where they're on it (fast), else pushed by this
    # script (Copy-Item to the seat).
    $copies = New-Object Collections.ArrayList; $pushes = New-Object Collections.ArrayList
    $item = {
        param($source, $dest, $skip)
        $skipRel = @($skip | Where-Object { & $under $_ $source } | ForEach-Object { $_.Substring($source.Length).TrimStart('\') })
        if (& $under $source $gamesRoot) {
            [void]$copies.Add([ordered]@{ share = (& $rel $source); dest = $dest; exclude = @($skipRel | ForEach-Object { Join-Path (& $rel $source) $_ }) })
        } else {
            [void]$pushes.Add([ordered]@{ source = $source; dest = $dest; exclude = $skipRel })
        }
    }
    $skip = @($rom, $(if ($guestMedia) { $media }))
    & $item $esDeDir 'C:\ES-DE' $skip
    if ($emuDest) { & $item $emulators $emuDest $skip }
    if (-not (& $under $data $esDeDir)) { & $item $data $dataDest $skip }

    $roamingFrom = ([string]$config.roaming).TrimEnd('\')
    $rewrites = @(
        @{ from = $rom; to = $guestRom }
        $(if ($guestMedia) { @{ from = $media; to = $guestMedia } })
        $(if ($emuDest) { @{ from = $emulators; to = $emuDest } })
        @{ from = $data; to = $dataDest }
        @{ from = $esDeDir; to = 'C:\ES-DE' }
        $(if ($roamingFrom) { @{ from = $roamingFrom; to = "C:\Users\$($State.arcadeUser)\AppData\Roaming" } })
        @{ from = $gamesRoot; to = $guestGames }
    ) | Where-Object { $_ }

    [ordered]@{
        name          = $State.name
        arcadeUser    = $State.arcadeUser
        hostAddress   = $hostAddress
        port          = $State.port
        share         = "\\$hostAddress\$($share.name)"
        shareUser     = "$env:COMPUTERNAME\$($share.user)"
        sharePassword = $share.password
        gamesLetter   = $letter
        copies        = @($copies)
        pushes        = @($pushes)
        rewrites      = @($rewrites)
        esDeDataDest  = $dataDest
        romDir        = $guestRom
        mediaDir      = $(if ($guestMedia) { $guestMedia } else { '' })
        bios          = $(if ($config.bios) { & $onShare $config.bios } else { $null })
        sunshineConf  = $conf
        clientCert    = $State.clientCert
        sunshineUser  = ''
        sunshinePassword = ''
        arcadePassword = ''
    }
}

# Copies a folder from this PC into the seat, leaving out some of its
# top-level folders (ROMs, media: they stay on the share).
function Push-Folder($Session, $Push) {
    Invoke-Command -Session $Session -ArgumentList $Push.dest -ScriptBlock { param($d) New-Item -ItemType Directory -Force $d | Out-Null }
    foreach ($child in Get-ChildItem -LiteralPath $Push.source -Force) {
        if ($child.Name -in @($Push.exclude)) { continue }
        Copy-Item -ToSession $Session -LiteralPath $child.FullName -Destination (Join-Path $Push.dest $child.Name) -Recurse -Force
    }
}

# Runs one of seat-guest.ps1's steps inside the seat, with Setup's scripts
# and Luma Arcade's helpers next to it.
function Invoke-GuestStep($State, [string]$Step) {
    $seat = $State.name
    $session = New-SeatSession $seat
    try {
        $plan = Get-GuestPlan $State
        $cred = Read-Json (Cred-File $seat)
        $plan.sunshineUser = $cred.sunshineUser
        $plan.sunshinePassword = $cred.sunshinePassword
        $plan.arcadePassword = $cred.arcadePassword
        Invoke-Command -Session $session -ScriptBlock {
            foreach ($d in 'C:\SeatSetup', 'C:\SeatSetup\setup', 'C:\SeatSetup\luma\host') { New-Item -ItemType Directory -Force $d | Out-Null }
            # Only administrators: the plan has passwords in it.
            & icacls.exe C:\SeatSetup /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' /T /C /Q | Out-Null
        }
        Copy-Item -ToSession $session -Path (Join-Path $DataDir 'seat-guest.ps1') -Destination 'C:\SeatSetup\seat-guest.ps1' -Force
        Copy-Item -ToSession $session -Path (Join-Path $SetupDir '*') -Destination 'C:\SeatSetup\setup' -Recurse -Force
        # Luma Arcade's helper scripts, as installed on this PC.
        Get-ChildItem $DataDir -Filter *.ps1 -File | Where-Object { $_.Name -notmatch '^seat-(manager|sync)\.ps1$' } |
            ForEach-Object { Copy-Item -ToSession $session -LiteralPath $_.FullName -Destination "C:\SeatSetup\luma\host\$($_.Name)" -Force }
        foreach ($sub in 'launchers') {
            $dir = Join-Path $DataDir $sub
            if (Test-Path $dir) { Copy-Item -ToSession $session -Path $dir -Destination 'C:\SeatSetup\luma\host' -Recurse -Force }
        }
        if ($Step -eq 'games') {
            foreach ($push in $plan.pushes) {
                Set-Stage $State 'games' "Copying $($push.source)"
                Push-Folder $session $push
            }
        }
        $planJson = $plan | ConvertTo-Json -Depth 5
        Invoke-Command -Session $session -ArgumentList $planJson -ScriptBlock { param($j) Set-Content -Path 'C:\SeatSetup\plan.json' -Value $j -Encoding UTF8 }

        $lines = Invoke-Command -Session $session -ArgumentList $Step -ScriptBlock {
            param($s)
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\SeatSetup\seat-guest.ps1 -Step $s 2>&1 | ForEach-Object { "$_" }
        }
        $answer = $null
        foreach ($line in @($lines)) {
            if ($line -match '^\{.*"ok"') { $answer = $line | ConvertFrom-Json }
            else { Write-Log "  $line" $seat }
        }
        if (-not $answer) { throw "$Step inside $seat gave no answer" }
        if (-not $answer.ok) { throw "$Step inside $seat failed: $($answer.error)" }
        $answer
    } finally {
        Invoke-Command -Session $session -ScriptBlock { Remove-Item 'C:\SeatSetup\plan.json' -Force -ErrorAction SilentlyContinue } -ErrorAction SilentlyContinue
        Remove-PSSession $session
    }
}

function Invoke-Build($Request) {
    $seat = $Request.name
    $state = Read-Seat $seat
    if (-not $state) {
        New-Item -ItemType Directory -Force (Seat-Dir $seat) | Out-Null
        Protect-Path (Seat-Dir $seat)
        $state = [pscustomobject]@{ name = $seat; created = (Get-Date).ToString('o'); done = @(); stage = 'checks'; detail = ''; error = $null; finished = $false }
    }
    # What was asked; a repair only brings the software steps back.
    foreach ($k in 'iso', 'memoryGb', 'cpus', 'diskGb', 'gpuShare', 'gpu', 'clientCert', 'port', 'storage') {
        if ($null -ne $Request.$k -and "$($Request.$k)" -ne '') { $state | Add-Member -NotePropertyName $k -NotePropertyValue $Request.$k -Force }
    }
    if ($Request.repair) { $state.done = @($state.done | Where-Object { $_ -notin 'games', 'software', 'pair' }) }
    $state.error = $null
    $state.finished = $false
    Save-Seat $state

    $credFile = Join-Path (Seat-Dir $seat) 'credentials.json'
    if (-not (Test-Path $credFile)) {
        Save-Json ([ordered]@{ adminUser = 'LumaAdmin'; adminPassword = New-Password; arcadeUser = 'Arcade'; arcadePassword = New-Password; sunshineUser = 'luma'; sunshinePassword = New-Password }) $credFile
        Protect-Path $credFile
    }
    $cred = Read-Json $credFile
    $state | Add-Member -NotePropertyName arcadeUser -NotePropertyValue $cred.arcadeUser -Force

    try {
        if ('checks' -notin $state.done) {
            Set-Stage $state 'checks'
            $info = Get-HostInfo -Fresh
            if ($info.hyperV -ne 'on') { throw ($info.problems -join ' ') }
            $gpus = @($info.gpus)
            if (-not $gpus) { throw 'No graphics card here can be partitioned' }
            $gpu = if ($state.gpu) { $gpus | Where-Object path -eq $state.gpu | Select-Object -First 1 }
            if (-not $gpu) { $gpu = ($gpus | Sort-Object { if ($_.vendor -eq 'Intel') { 1 } else { 0 } } | Select-Object -First 1) }
            $state | Add-Member -NotePropertyName gpu -NotePropertyValue $gpu.path -Force
            $state | Add-Member -NotePropertyName gpuName -NotePropertyValue $gpu.name -Force
            if (-not $info.switch) { throw 'No Hyper-V network switch connected to the home network: get this PC ready first' }
            if (-not $info.share) { throw 'The games folder isn''t shared yet: get this PC ready first' }
            if (-not (Get-VM -Name $seat -ErrorAction SilentlyContinue)) {
                if (-not $state.iso -or -not (Test-Path -LiteralPath $state.iso)) { throw "The Windows installation disc ($($state.iso)) isn't there" }
                if ($info.freeMemoryGb -lt $state.memoryGb) { Write-Log "Only $($info.freeMemoryGb) GB of memory is free right now; the seat needs $($state.memoryGb) GB to start" $seat }
            }
            Complete-Stage $state 'checks'
        }
        if ('answer' -notin $state.done) {
            Set-Stage $state 'answer'
            $image = Get-IsoImage $state.iso
            Write-Log "Installing $($image.Name) ($($image.Language))" $seat
            $state | Add-Member -NotePropertyName windows -NotePropertyValue $image.Name -Force
            New-AnswerIso $state $cred $image | Out-Null
            Complete-Stage $state 'answer'
        }
        if ('vm' -notin $state.done) {
            Set-Stage $state 'vm'
            New-SeatVm $state (Join-Path (Seat-Dir $seat) 'unattend.iso')
            Complete-Stage $state 'vm'
        }
        if ('windows' -notin $state.done) {
            Set-Stage $state 'windows'
            Wait-Windows $state
            Complete-Stage $state 'windows'
        }
        if ('driver' -notin $state.done) {
            Set-Stage $state 'driver'
            Copy-GpuDriver $state
            Complete-Stage $state 'driver'
        }
        if ('games' -notin $state.done) {
            Set-Stage $state 'games' 'Tens of gigabytes can take a while'
            Invoke-GuestStep $state 'games' | Out-Null
            Complete-Stage $state 'games'
        }
        if ('software' -notin $state.done) {
            Set-Stage $state 'software'
            Invoke-GuestStep $state 'software' | Out-Null
            Restart-Seat $state
            Complete-Stage $state 'software'
        }
        if ('pair' -notin $state.done) {
            Set-Stage $state 'pair'
            $answer = Invoke-GuestStep $state 'pair'
            $state | Add-Member -NotePropertyName serverCert -NotePropertyValue $answer.serverCert -Force
            $address = $null
            for ($i = 0; $i -lt 12 -and -not $address; $i++) { $address = Get-VmAddress $seat; if (-not $address) { Start-Sleep 5 } }
            if (-not $address) { throw "$seat has no address on the home network" }
            $state | Add-Member -NotePropertyName address -NotePropertyValue $address -Force
            Complete-Stage $state 'pair'
        }
        $state.finished = $true
        Set-Stage $state 'ready' 'Luma Arcade pairs it in a moment'
    } catch {
        $state.error = $_.Exception.Message
        Save-Seat $state
        Write-Log "FAILED at $($state.stage): $($_.Exception.Message)" $seat
        throw
    }
}

# ------------------------------------------------------------------ remove, power

function Invoke-Remove($Request) {
    $seat = $Request.name
    $state = Read-Seat $seat
    $vm = Get-VM -Name $seat -ErrorAction SilentlyContinue
    if ($vm -and -not $state) { throw "$seat wasn't made by Luma Arcade: it's left alone (remove it in Hyper-V Manager)" }
    if ($vm) {
        Write-Log "Removing $seat's virtual machine" $seat
        if ($vm.State -ne 'Off') { Stop-VM -Name $seat -TurnOff -Force }
        $disks = @(Get-VMHardDiskDrive -VMName $seat | ForEach-Object Path)
        Remove-VM -Name $seat -Force
        foreach ($d in $disks) { Remove-Item -LiteralPath $d -Force -ErrorAction SilentlyContinue }
    }
    if ($state -and $state.vmDir -and (Test-Path $state.vmDir) -and ((Split-Path $state.vmDir -Leaf) -eq "Luma Arcade $seat")) { Remove-Tree $state.vmDir }
    Remove-Tree (Seat-Dir $seat)
    Write-Log "$seat removed"
}

function Invoke-Power($Request) {
    $seat = $Request.name
    $vm = Get-VM -Name $seat -ErrorAction SilentlyContinue
    if (-not $vm) { throw "There's no virtual machine called $seat" }
    switch ($Request.op) {
        'start' { if ($vm.State -ne 'Running') { Start-VM -Name $seat } }
        # Through Windows (Hyper-V's shutdown integration), not pulling the plug.
        'stop' { if ($vm.State -eq 'Running') { Stop-VM -Name $seat -Force } }
        'restart' {
            if ($vm.State -ne 'Running') { Start-VM -Name $seat }
            else {
                $state = Read-Seat $seat
                if (-not $state) { $state = [pscustomobject]@{ name = $seat } }
                Restart-Seat $state
            }
        }
        default { throw "Unknown power action $($Request.op)" }
    }
    Write-Log "$seat`: $($Request.op)" $seat
}

# Uninstalling: the seats Luma Arcade built, the games share and its
# account. Hyper-V, its network switch and the GPU policy stay as they are
# (other virtual machines may use them).
function Invoke-Teardown {
    foreach ($seat in Get-SeatNames) {
        if (Read-Seat $seat) {
            try { Invoke-Remove ([pscustomobject]@{ name = $seat }) } catch { Write-Log "Couldn't remove $seat`: $($_.Exception.Message)" }
        } else { Write-Log "$seat wasn't made by Luma Arcade: left alone" }
    }
    if (Get-SmbShare -Name $ShareName -ErrorAction SilentlyContinue) { Remove-SmbShare -Name $ShareName -Force }
    if (Get-LocalUser -Name $ShareUser -ErrorAction SilentlyContinue) { Remove-LocalUser -Name $ShareUser }
    Get-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    foreach ($f in $ShareFile, $HostInfoFile, $StatusFile) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
    Write-Log 'Extra seats removed. Hyper-V, its network switch and the GPU policy are left as they were.'
}

# ------------------------------------------------------------------ saves

# A player's saves in or out of a seat (server/src/web/saveSync.ts). Paths
# are made here, never taken from the request.
function Invoke-Sync($Request) {
    $seat = $Request.name
    $id = [int64]$Request.playerId
    if ($id -le 0) { throw 'Bad player' }
    $player = "$id`:$($Request.playerName -replace '[\r\n"]', '')"
    $seatDir = Join-Path $GuestSyncDir "user-$id"
    switch ($Request.mode) {
        'export' {
            # Seat -> this PC: into a folder only SYSTEM and admins can change
            # (Luma Arcade reads it to import on the main PC).
            $hostDir = Join-Path $StagingDir "user-$id"
            Remove-Tree $hostDir
            New-Item -ItemType Directory -Force $hostDir | Out-Null
            $session = New-SeatSession $seat
            try {
                $line = @(Invoke-Command -Session $session -ArgumentList $player, $seatDir -ScriptBlock {
                    param($p, $d)
                    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\LumaArcade\profiles.ps1 -Action export -Player $p -Dir $d
                })[-1]
                if ($line -notmatch '"exported"') { throw "the seat couldn't export: $line" }
                Copy-Item -FromSession $session -Path (Join-Path $seatDir '*') -Destination $hostDir -Recurse -Force
            } finally { Remove-PSSession $session }
            # Readable by everyone (the games account imports it).
            & icacls.exe $hostDir /grant '*S-1-5-32-545:(OI)(CI)RX' /T /C /Q | Out-Null
            return @{ dir = $hostDir }
        }
        { $_ -in 'import', 'apply' } {
            # This PC -> seat: what Luma Arcade exported from the main PC (or
            # a seat's export staged here).
            $from = $Request.from
            $allowed = @((Join-Path $StagingDir "user-$id"), (Join-Path $DataDir "sync-out\user-$id"))
            if ($from -notin $allowed) { throw "Saves can only come from $($allowed -join ' or ')" }
            if (-not (Test-Path -LiteralPath $from)) { throw "$from isn't there" }
            if ((Test-ReparsePoint $from) -or (Get-ChildItem -LiteralPath $from -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue)) { throw "$from has links in it: not copying" }
            $session = New-SeatSession $seat
            try {
                Invoke-Command -Session $session -ArgumentList $seatDir -ScriptBlock {
                    param($d)
                    if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force }
                    New-Item -ItemType Directory -Force -Path $d | Out-Null
                }
                Copy-Item -ToSession $session -Path (Join-Path $from '*') -Destination $seatDir -Recurse -Force
                if ($Request.mode -eq 'apply') {
                    $line = @(Invoke-Command -Session $session -ArgumentList $player, $seatDir -ScriptBlock {
                        param($p, $d)
                        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\LumaArcade\profiles.ps1 -Action import -Player $p -Dir $d
                    })[-1]
                    if ($line -notmatch '"imported"') { throw "the seat couldn't import: $line" }
                }
            } finally { Remove-PSSession $session }
            return @{ dir = $seatDir }
        }
        default { throw "Unknown sync mode $($Request.mode)" }
    }
}

# ------------------------------------------------------------------ one job

function Read-Request([string]$File) {
    $r = Read-Json $File
    if (-not $r) { throw "Unreadable request $File" }
    if ($r.name -and $r.name -notmatch $SeatNamePattern) { throw "Bad seat name '$($r.name)'" }
    $r
}

function Write-Response([string]$Id, $Answer) {
    if (-not $Id -or $Id -notmatch '^[\w-]{1,64}$') { return }
    Save-Json $Answer (Join-Path $ResponsesDir "$Id.json")
}

if ($Action -ne 'serve') {
    $request = if ($RequestFile) { Read-Request $RequestFile } else { [pscustomobject]@{ name = $Name } }
    if ($RequestFile) { Remove-Item -LiteralPath $RequestFile -Force -ErrorAction SilentlyContinue }
    try {
        $result = switch ($Action) {
            'check' { Get-HostInfo -Fresh | Out-Null; @{} }
            'prepare' { Invoke-Prepare $request; Get-HostInfo -Fresh | Out-Null }
            'build' { Invoke-Build $request; @{} }
            'remove' { Invoke-Remove $request; @{} }
            'power' { Invoke-Power $request; @{} }
            'sync' { Invoke-Sync $request }
            'teardown' { Invoke-Teardown; @{} }
        }
        $answer = @{ ok = $true }
        if ($result -is [hashtable]) { foreach ($k in $result.Keys) { $answer[$k] = $result[$k] } }
        Write-Response $request.id $answer
        exit 0
    } catch {
        Write-Log "$Action $($request.name) failed: $($_.Exception.Message)" $request.name
        Write-Response $request.id @{ ok = $false; error = $_.Exception.Message }
        exit 1
    }
}

# ------------------------------------------------------------------ the loop

$mutex = New-Object Threading.Mutex($false, 'Global\LumaArcadeSeatManager')
if (-not $mutex.WaitOne(0)) { Write-Output 'Already running'; exit 0 }

Write-Log "Seat manager started (pid $PID)"
$jobs = @{}
$kinds = @{ check = 'check'; prepare = 'prepare'; create = 'build'; repair = 'build'; remove = 'remove'; start = 'power'; stop = 'power'; restart = 'power'; sync = 'sync' }
$lastStatus = [datetime]::MinValue
$freshHost = $true
# With no seats it doesn't stay running: the website starts it again when
# someone opens Extra seats (or asks for something).
$lastActivity = Get-Date
$idleExit = [TimeSpan]::FromMinutes(15)

# Getting ready, after the restart Hyper-V needed.
if ((Test-Path $PreparePending) -and (Get-HyperVState) -eq 'on') {
    $pending = Read-Json $PreparePending
    if ($pending) {
        $pending | Add-Member -NotePropertyName id -NotePropertyValue '' -Force
        Save-Json $pending (Join-Path $RequestsDir ('prepare-' + (Get-Date -Format 'yyyyMMddHHmmss') + '.json'))
        Write-Log 'Hyper-V is on now: carrying on getting this PC ready'
    }
    Remove-Item -LiteralPath $PreparePending -Force
}

# A seat left half-built by a restart (Hyper-V's, say) carries on.
foreach ($seat in Get-SeatNames) {
    $s = Read-Seat $seat
    if ($s -and -not $s.finished -and -not $s.error) {
        $file = Join-Path $RequestsDir ("resume-$seat-" + (Get-Date -Format 'yyyyMMddHHmmss') + '.json')
        Save-Json ([ordered]@{ action = 'create'; name = $seat; id = '' }) $file
    }
}

while ($true) {
    $changed = $false
    foreach ($key in @($jobs.Keys)) {
        if ($jobs[$key].Process.HasExited) { $jobs.Remove($key); $changed = $true; $freshHost = $true }
    }
    foreach ($file in Get-ChildItem $RequestsDir -Filter *.json -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime) {
        try {
            $r = Read-Request $file.FullName
            $kind = $kinds[[string]$r.action]
            if (-not $kind) { throw "Unknown action '$($r.action)'" }
            if ($kind -in 'build', 'remove', 'power', 'sync' -and -not $r.name) { throw "$($r.action) needs a seat name" }
            $busy = $jobs.Values | Where-Object { $_.Name -eq $r.name -and $_.Kind -in 'build', 'remove', 'power' -and -not $_.Process.HasExited }
            if ($kind -eq 'remove' -and $busy) {
                # Removing a seat that's still being built stops the build.
                foreach ($b in @($busy)) { Write-Log "Stopping $($b.Kind) of $($r.name) to remove it"; Stop-Process -Id $b.Process.Id -Force -ErrorAction SilentlyContinue }
                Start-Sleep 2
            } elseif ($busy -and $kind -ne 'sync') { continue }
            if ($kind -eq 'prepare' -and ($jobs.Values | Where-Object { $_.Kind -eq 'prepare' -and -not $_.Process.HasExited })) { continue }
            # One seat built at a time: two Windows installs at once would
            # starve this PC (and whoever's playing on it).
            if ($kind -eq 'build' -and ($jobs.Values | Where-Object { $_.Kind -in 'build', 'prepare' -and -not $_.Process.HasExited })) { continue }
            # The job gets its own copy of the request (it deletes it).
            $jobFile = Join-Path $SeatsDir ("job-" + [guid]::NewGuid().ToString('N') + '.json')
            if ($r.action -eq 'repair') { $r | Add-Member -NotePropertyName repair -NotePropertyValue $true -Force }
            if ($kind -eq 'power') { $r | Add-Member -NotePropertyName op -NotePropertyValue $r.action -Force }
            Save-Json $r $jobFile
            Protect-Path $jobFile
            Remove-Item -LiteralPath $file.FullName -Force
            $psArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Action', $kind, '-RequestFile', "`"$jobFile`"", '-DataDir', "`"$DataDir`"")
            $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $psArgs -WindowStyle Hidden -PassThru
            $jobs["$kind-$($r.name)-$($p.Id)"] = [pscustomobject]@{ Kind = $kind; Name = [string]$r.name; Process = $p; Started = (Get-Date).ToString('o') }
            Write-Log "Started $($r.action)$(if ($r.name) { " $($r.name)" })"
            $changed = $true
            $lastActivity = Get-Date
        } catch {
            Write-Log "Request $($file.Name) refused: $($_.Exception.Message)"
            try { $bad = Read-Json $file.FullName; if ($bad) { Write-Response $bad.id @{ ok = $false; error = $_.Exception.Message } } } catch { }
            Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
        }
    }
    if ($changed -or ((Get-Date) - $lastStatus).TotalSeconds -ge 15) {
        try { Write-Status $jobs -FreshHost:$freshHost; $freshHost = $false } catch { Write-Log "Status failed: $($_.Exception.Message)" }
        $lastStatus = Get-Date
    }
    if ($jobs.Count -eq 0 -and ((Get-Date) - $lastActivity) -gt $idleExit -and -not @(Get-SeatNames)) {
        Write-Log 'No seats and nothing to do: stopping until the website needs it'
        break
    }
    # Old answers nobody picked up.
    Get-ChildItem $ResponsesDir -Filter *.json -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-1) } | Remove-Item -Force -ErrorAction SilentlyContinue
    Start-Sleep 2
}
