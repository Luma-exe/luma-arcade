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

@(
    '[hw]'
    "encoder=$encoder"
    "monitors=$monitors"
    "vdd=$([int]$vdd)"
    "vigem=$([int]$vigem)"
    "xusb=$([int]$xusb)"
    "sunshineuser=$([int]$sunshineUser)"
) | Set-Content -Path $Out -Encoding Unicode
