# Setup's "Extra seats" page (runs elevated, after install-host.ps1 set up
# the seat manager): asks the seat manager (C:\ProgramData\LumaArcade\
# seat-manager.ps1, the \LumaArcade\Seats task) to get this PC ready - Hyper-V,
# GPU partitioning, a network switch, the games share - and then to build
# -Count seats from the Windows disc -Iso. Turning Hyper-V on needs a
# restart; the manager carries on by itself after it. Settings > Extra seats
# shows how far it's got, and adds or removes seats later.
#  -LumaDir         Luma Arcade's folder (moonlight-web-stream's pairing: the
#                   seats trust its certificate)
#  -Port            Luma Arcade's port (the seats ask it who's playing)
#  -AllowGpuPolicy  Windows Server: let Hyper-V partition a gaming graphics card
#  -Count           seats to build (0: just get the PC ready)
#  -Iso             a Windows 10/11 Pro, Enterprise or Education .iso
#  -MemoryGb, -Cpus, -DiskGb   each seat's share of this PC
param(
    [Parameter(Mandatory)][string]$LumaDir,
    [int]$Port = 7777,
    [switch]$AllowGpuPolicy,
    [ValidateRange(0, 3)][int]$Count = 0,
    [string]$Iso = '',
    [int]$MemoryGb = 6,
    [int]$Cpus = 0,
    [int]$DiskGb = 128
)
. (Join-Path $PSScriptRoot 'common.ps1')

$dataDir = 'C:\ProgramData\LumaArcade'
$seatsDir = Join-Path $dataDir 'seats'
if (-not (Test-Path (Join-Path $dataDir 'seat-manager.ps1'))) { throw "The seat manager isn't installed ($dataDir\seat-manager.ps1)" }

function Save-Request([string]$Dir, [string]$Name, $Body) {
    New-Item -ItemType Directory -Force $Dir | Out-Null
    $file = Join-Path $Dir "$Name.json"
    $Body | ConvertTo-Json -Depth 5 | Set-Content -Path "$file.tmp" -Encoding UTF8
    Move-Item "$file.tmp" $file -Force
}

Write-Step 'Extra seats: getting this PC ready (Hyper-V, GPU partitioning, network switch, games share)'
if ($AllowGpuPolicy) { Write-Note 'Hyper-V may partition this gaming graphics card (Windows Server policy)' }

if ($Count -gt 0) {
    if (-not $Iso -or -not (Test-Path -LiteralPath $Iso)) { throw "The Windows disc $Iso isn't there" }
    # The seats trust the certificate Luma Arcade paired this PC's Sunshine with.
    $data = Join-Path $LumaDir 'moonlight-web-stream\server\data.json'
    $cert = $null
    if (Test-Path $data) {
        $hosts = (Get-Content -Raw $data | ConvertFrom-Json).hosts
        foreach ($h in $hosts.PSObject.Properties.Value) {
            if ($h.address -match '^(localhost|127\.0\.0\.1|::1)$' -and $h.pair_info.client_certificate) { $cert = $h.pair_info.client_certificate; break }
        }
    }
    if (-not $cert) { throw "Luma Arcade isn't paired with this PC's Sunshine yet, so seats couldn't be paired. Add them from Settings > Extra seats once it is." }
    $cores = [Environment]::ProcessorCount
    if ($Cpus -le 0) { $Cpus = [math]::Max(2, [math]::Min(6, [math]::Floor(($cores - 2) / ($Count + 1)))) }
    $share = @{ 1 = 0.5; 2 = 0.33; 3 = 0.25 }[$Count]
    # Names after the main PC (seat 1), skipping any virtual machine already
    # called that.
    $taken = @()
    if (Get-Command Get-VM -ErrorAction SilentlyContinue) { $taken += Get-VM -ErrorAction SilentlyContinue | ForEach-Object Name }
    $taken += Get-ChildItem $seatsDir -Directory -ErrorAction SilentlyContinue | ForEach-Object Name
    $n = 2
    for ($i = 0; $i -lt $Count; $i++) {
        while ($taken -contains "Seat$n") { $n++ }
        $name = "Seat$n"
        $taken += $name
        Save-Request (Join-Path $seatsDir 'after-prepare') ("{0:D2}-$name" -f $i) ([ordered]@{
            action = 'create'; id = ''; name = $name; iso = $Iso; memoryGb = $MemoryGb; cpus = $Cpus; diskGb = $DiskGb
            gpuShare = $share; clientCert = $cert; port = $Port
        })
        Write-Note "$name`: $MemoryGb GB memory, $Cpus processors, $DiskGb GB disk, $([math]::Round($share * 100))% of the graphics card - built once the PC is ready (about an hour each, one after another)"
    }
}

Save-Request (Join-Path $seatsDir 'requests') ('setup-prepare-' + (Get-Date -Format 'yyyyMMddHHmmss')) ([ordered]@{
    action = 'prepare'; id = ''; allowGpuPolicy = [bool]$AllowGpuPolicy; storage = ''; port = $Port
})
& schtasks.exe /run /tn '\LumaArcade\Seats' | Out-Null
if ($LASTEXITCODE) { Write-Note "Couldn't start the seat manager now; it starts with Windows" }
else { Write-Note 'Started. If Hyper-V had to be turned on, restart this PC: it carries on after. Settings > Extra seats shows how far it has got.' }
Write-Step 'Extra seats: queued'
