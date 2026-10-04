# What the installer needs to know about this PC's hardware, written as an
# .ini file for it to read (-Out):
#   encoder  = the graphics card Sunshine can encode video with (NVIDIA, AMD
#              or Intel), empty if there's none (it would fall back to the
#              processor: slow, and too slow for more than one player)
#   monitors = physical monitors plugged in (Sunshine can only capture a
#              screen that's switched on; with none, a virtual display
#              driver gives it one)
#   vdd      = 1 if the virtual display driver is already installed
#   vigem    = 1 if ViGEmBus is installed: Sunshine turns players'
#              controllers into virtual Xbox 360 or PlayStation 4 pads on it
#   xusb     = 1 if the Xbox 360 controller driver is installed (Windows
#              Server doesn't ship it; virtual Xbox 360 pads need it)
#   sunshineuser = 1 if Sunshine is installed and already has a web page
#              sign-in (Setup can't pair with it unless it's replaced)
#   hyperv   = on | off | restart | unavailable: extra seats are Hyper-V
#              virtual machines (Windows Home has no Hyper-V)
#   seatgpu  = 1 if Hyper-V can give a virtual machine a slice of a graphics
#              card here (only known while Hyper-V is on)
#   gpupolicy = 1 if Windows Server's Hyper-V policies let it partition a
#              gaming graphics card (always 1 on Windows 10/11)
param([Parameter(Mandatory)] [string]$Out)
$ErrorActionPreference = 'SilentlyContinue'

# PCI vendor ids of the graphics makers Sunshine has hardware encoders for.
$vendors = @{ '10DE' = 'NVIDIA'; '1002' = 'AMD'; '8086' = 'Intel' }
$gpus = @(Get-CimInstance Win32_VideoController | Where-Object {
    $_.PNPDeviceID -match '^PCI\\VEN_([0-9A-F]{4})' -and $vendors.ContainsKey($Matches[1])
})
# The one Sunshine would pick first: a separate card over built-in graphics.
$encoder = ($gpus | Sort-Object { if ($_.PNPDeviceID -match 'VEN_8086') { 1 } else { 0 } } | Select-Object -First 1).Name

# Virtual monitors don't count: the virtual display driver's (MTT1337) and
# Remote Desktop's.
$monitors = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorConnectionParams | Where-Object {
    $_.Active -and $_.InstanceName -notmatch 'MTT1337|Default_Monitor'
}).Count

$vdd = [bool](Get-CimInstance Win32_PnPEntity -Filter "PNPDeviceID LIKE 'ROOT\\DISPLAY\\%'" | Where-Object { $_.HardwareID -contains 'Root\MttVDD' })
$vigem = [bool](Get-CimInstance Win32_PnPEntity -Filter "PNPDeviceID LIKE 'ROOT\\SYSTEM\\%'" | Where-Object { $_.HardwareID -contains 'Nefarius\ViGEmBus\Gen1' })
$xusb = (Test-Path "$env:SystemRoot\System32\drivers\xusb22.sys") -or (Test-Path "$env:SystemRoot\System32\drivers\xusb21.sys")
$state = Join-Path $env:ProgramFiles 'Sunshine\config\sunshine_state.json'
$sunshineUser = (Test-Path $state) -and [bool](Get-Content -Raw $state | ConvertFrom-Json).username

$server = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').InstallationType -eq 'Server'
$hyperV = 'unavailable'
if ($server) {
    $f = Get-WindowsFeature -Name Hyper-V
    if ($f) { $hyperV = if ($f.InstallState -eq 'InstallPending') { 'restart' } elseif ($f.Installed) { 'on' } else { 'off' } }
} else {
    $f = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All
    if ($f) { $hyperV = if ($f.State -eq 'EnablePending') { 'restart' } elseif ($f.State -eq 'Enabled') { 'on' } else { 'off' } }
}
$seatGpu = $false
if ($hyperV -eq 'on') {
    foreach ($cmd in 'Get-VMHostPartitionableGpu', 'Get-VMPartitionableGpu') {
        if (Get-Command $cmd -ErrorAction SilentlyContinue) { $seatGpu = [bool](& $cmd); break }
    }
}
$policy = Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\HyperV' -ErrorAction SilentlyContinue
$gpuPolicy = -not $server -or ($policy -and $policy.RequireSecureDeviceAssignment -eq 0 -and $policy.RequireSupportedDeviceAssignment -eq 0)

@(
    '[hw]'
    "encoder=$encoder"
    "monitors=$monitors"
    "vdd=$([int]$vdd)"
    "vigem=$([int]$vigem)"
    "xusb=$([int]$xusb)"
    "sunshineuser=$([int]$sunshineUser)"
    "hyperv=$hyperV"
    "seatgpu=$([int]$seatGpu)"
    "gpupolicy=$([int]$gpuPolicy)"
) | Set-Content -Path $Out -Encoding Unicode
