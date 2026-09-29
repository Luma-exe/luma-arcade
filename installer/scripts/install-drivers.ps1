# Drivers a streaming PC may be missing (runs elevated):
#  -Xusb            Microsoft's Xbox 360 controller driver. Windows Server
#                   doesn't ship it, and without it Sunshine's virtual
#                   controllers (and real Xbox pads) don't reach games.
#  -VirtualDisplay  the Virtual Display Driver (MttVDD): a monitor that
#                   isn't there, for a PC with no screen plugged in. Sunshine
#                   switches it to each player's size and frame rate.
#  -VddSettings     its modes (vdd_settings.xml, the sizes the stream page
#                   can ask for); an existing C:\VirtualDisplayDriver copy
#                   is kept.
#  -Latest          newest downloads instead of the tested versions
param(
    [switch]$Xusb,
    [switch]$VirtualDisplay,
    [string]$VddSettings = '',
    [switch]$Latest
)
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'catalog.ps1')

$failed = $false

function Expand-Cab([string]$File, [string]$Destination) {
    New-Item -ItemType Directory -Force $Destination | Out-Null
    & "$env:SystemRoot\System32\expand.exe" $File -F:* $Destination | Out-Null
    if ($LASTEXITCODE) { throw "couldn't unpack $File" }
}

function Install-Inf([string]$Inf) {
    $out = & "$env:SystemRoot\System32\pnputil.exe" /add-driver $Inf /install
    # 0 = done, 259 = nothing to do (already there), 3010 = done, restart needed.
    if ($LASTEXITCODE -notin 0, 259, 3010) { throw "pnputil failed ($LASTEXITCODE): $($out -join ' ')" }
    if ($LASTEXITCODE -eq 3010) { Write-Note 'Windows needs a restart to finish this driver' }
}

if ($Xusb) {
    Write-Step 'Xbox 360 controller driver (Microsoft)'
    try {
        if ((Test-Path "$env:SystemRoot\System32\drivers\xusb22.sys") -or (Test-Path "$env:SystemRoot\System32\drivers\xusb21.sys")) {
            Write-Note 'already installed'
        } else {
            $src = Get-CatalogDownload 'xusb' -Latest:$Latest
            $cab = Save-CatalogDownload 'xusb' $src
            $dir = Join-Path $script:DownloadDir 'xusb'
            Expand-Cab $cab $dir
            Install-Inf (Join-Path $dir 'xusb21.inf')
            Remove-Item -Recurse -Force $dir, $cab
            Write-Note "installed ($($src.Version))"
        }
    } catch {
        Write-Note "FAILED: $($_.Exception.Message). Install ""Xbox 360 Controller for Windows"" from the Microsoft Update Catalog."
        $failed = $true
    }
}

if ($VirtualDisplay) {
    Write-Step 'Virtual Display Driver (a screen for Sunshine when no monitor is plugged in)'
    try {
        # Its modes first, so it starts with every size a stream can ask for.
        $settingsDir = 'C:\VirtualDisplayDriver'
        $settings = Join-Path $settingsDir 'vdd_settings.xml'
        if ($VddSettings -and (Test-Path $VddSettings) -and -not (Test-Path $settings)) {
            New-Item -ItemType Directory -Force $settingsDir | Out-Null
            Copy-Item $VddSettings $settings
            Write-Note "screen sizes: $settings"
        }

        $present = Get-CimInstance Win32_PnPEntity -Filter "PNPDeviceID LIKE 'ROOT\\DISPLAY\\%'" | Where-Object { $_.HardwareID -contains 'Root\MttVDD' }
        if ($present) {
            Write-Note 'already installed'
        } else {
            $src = Get-CatalogDownload 'vdd' -Latest:$Latest
            $zip = Save-CatalogDownload 'vdd' $src
            $dir = Join-Path $script:DownloadDir 'vdd'
            if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
            Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
            $inf = Get-ChildItem $dir -Recurse -Filter MttVDD.inf | Select-Object -First 1
            if (-not $inf) { throw 'MttVDD.inf is missing from the download' }

            # A root device for the driver to attach to (what "devcon install"
            # does): it's a virtual device, so nothing would ever plug it in.
            Add-Type -Namespace LumaSetup -Name Devices -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct SP_DEVINFO_DATA { public int cbSize; public Guid ClassGuid; public int DevInst; public IntPtr Reserved; }
[DllImport("setupapi.dll", SetLastError = true)] static extern IntPtr SetupDiCreateDeviceInfoList(ref Guid ClassGuid, IntPtr hwndParent);
[DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool SetupDiCreateDeviceInfo(IntPtr set, string name, ref Guid ClassGuid, string desc, IntPtr hwndParent, int flags, ref SP_DEVINFO_DATA data);
[DllImport("setupapi.dll", SetLastError = true)] static extern bool SetupDiSetDeviceRegistryProperty(IntPtr set, ref SP_DEVINFO_DATA data, int property, byte[] buffer, int size);
[DllImport("setupapi.dll", SetLastError = true)] static extern bool SetupDiCallClassInstaller(int fn, IntPtr set, ref SP_DEVINFO_DATA data);
[DllImport("setupapi.dll", SetLastError = true)] static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
public static void CreateRootDevice(string className, Guid classGuid, string hardwareId) {
    IntPtr set = SetupDiCreateDeviceInfoList(ref classGuid, IntPtr.Zero);
    if (set == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
    try {
        var data = new SP_DEVINFO_DATA();
        data.cbSize = Marshal.SizeOf(data);
        if (!SetupDiCreateDeviceInfo(set, className, ref classGuid, null, IntPtr.Zero, 1 /* DICD_GENERATE_ID */, ref data))
            throw new System.ComponentModel.Win32Exception();
        byte[] ids = System.Text.Encoding.Unicode.GetBytes(hardwareId + "\0\0");
        if (!SetupDiSetDeviceRegistryProperty(set, ref data, 1 /* SPDRP_HARDWAREID */, ids, ids.Length))
            throw new System.ComponentModel.Win32Exception();
        if (!SetupDiCallClassInstaller(0x19 /* DIF_REGISTERDEVICE */, set, ref data))
            throw new System.ComponentModel.Win32Exception();
    } finally { SetupDiDestroyDeviceInfoList(set); }
}
'@
            [LumaSetup.Devices]::CreateRootDevice('Display', [Guid]'4d36e968-e325-11ce-bfc1-08002be10318', 'Root\MttVDD')
            Install-Inf $inf.FullName
            Remove-Item -Recurse -Force $dir, $zip
            Write-Note "installed ($($src.Version))"
        }
    } catch {
        Write-Note "FAILED: $($_.Exception.Message). Get it from github.com/VirtualDrivers/Virtual-Display-Driver."
        $failed = $true
    }
}

if ($failed) { exit 1 }
Write-Step 'Drivers done'
