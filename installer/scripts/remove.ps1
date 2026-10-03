# Removes what Setup installed besides Luma Arcade itself, for the
# uninstaller's "what to remove" list (runs elevated). Each part is only
# touched when asked for:
#  -Sunshine        Sunshine, with its settings, sign-in, paired devices
#                   and app pictures (C:\Program Files\Sunshine)
#  -EsDe            ES-DE in the games folder, its desktop shortcut and its
#                   settings and game lists in each account (ROMs and
#                   Emulators inside it stay unless asked for)
#  -Emulators       emulator keys (catalog.ps1), each with its settings and
#                   any saves kept in its own folder
#  -VirtualDisplay  the Virtual Display Driver and C:\VirtualDisplayDriver
#  -ViGEm           ViGEmBus, the virtual controller driver
#  -Games           the whole games folder: ROMs, saves, BIOS, ES-DE and
#                   emulators - and C:\ProgramData\LumaArcade (whose saves
#                   are where)
#  -GamesDir        the games folder Setup used
#  -Force           close whatever has a folder open without asking (a
#                   silent uninstall); otherwise each time it's asked first
#  -TestRoot        testing: Sunshine and ProgramData under this folder, and
#                   no services, drivers or uninstallers run
param(
    [string]$GamesDir = '',
    [switch]$Sunshine,
    [switch]$EsDe,
    [string]$Emulators = '',
    [switch]$VirtualDisplay,
    [switch]$ViGEm,
    [switch]$Games,
    [switch]$Force,
    [string]$TestRoot = ''
)
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'catalog.ps1')
$ErrorActionPreference = 'Continue'

$sunshineDir = Join-Path $env:ProgramFiles 'Sunshine'
$dataDir = 'C:\ProgramData\LumaArcade'
$profilesRoot = Split-Path $env:PUBLIC
if ($TestRoot) {
    $sunshineDir = Join-Path $TestRoot 'Sunshine'
    $dataDir = Join-Path $TestRoot 'LumaArcade'
    $profilesRoot = Join-Path $TestRoot 'Users'
}
$sunshineApps = Join-Path $sunshineDir 'config\apps.json'
$esdeDir = if ($GamesDir) { Join-Path $GamesDir 'ES-DE' } else { '' }
$failed = $false

# --- files in use: who has them, and closing them (asked first)

# Windows' Restart Manager: which programs have these files open.
Add-Type -Namespace LumaSetup -Name RestartManager -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType; public uint AppStatus; public uint TSSessionId; [MarshalAs(UnmanagedType.Bool)] public bool bRestartable; }
[DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
[DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint pSessionHandle);
[DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, IntPtr rgApplications, uint nServices, string[] rgsServiceNames);
[DllImport("rstrtmgr.dll")] static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);
public static int[] Holders(string[] files) {
    uint session; var ids = new System.Collections.Generic.List<int>();
    if (RmStartSession(out session, 0, Guid.NewGuid().ToString()) != 0) return ids.ToArray();
    try {
        if (RmRegisterResources(session, (uint)files.Length, files, 0, IntPtr.Zero, 0, null) != 0) return ids.ToArray();
        uint needed = 0, count = 0, reasons = 0;
        int r = RmGetList(session, out needed, ref count, null, ref reasons);
        if (r == 234 /* ERROR_MORE_DATA */ && needed > 0) {
            var info = new RM_PROCESS_INFO[needed]; count = needed;
            if (RmGetList(session, out needed, ref count, info, ref reasons) == 0)
                for (int i = 0; i < count; i++) ids.Add(info[i].Process.dwProcessId);
        }
    } finally { RmEndSession(session); }
    return ids.ToArray();
}
'@

# What's keeping $Path from going: programs running from inside it,
# programs with its files open, and File Explorer windows showing it.
function Get-Blockers([string]$Path) {
    $inside = $Path.TrimEnd('\') + '\'
    $ids = @{}
    Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($inside, 'OrdinalIgnoreCase') } | ForEach-Object { $ids[[int]$_.ProcessId] = $true }
    $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue | Select-Object -First 500 | ForEach-Object FullName)
    if ($files) { foreach ($id in [LumaSetup.RestartManager]::Holders($files)) { $ids[[int]$id] = $true } }
    $ids.Remove($PID)
    $procs = @($ids.Keys | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } | Where-Object { $_ -and $_.ProcessName -ne 'explorer' })
    $windows = @()
    try {
        $windows = @((New-Object -ComObject Shell.Application).Windows() | Where-Object {
            try { $p = $_.Document.Folder.Self.Path; $p -and ($p -eq $Path.TrimEnd('\') -or $p.StartsWith($inside, 'OrdinalIgnoreCase')) } catch { $false }
        })
    } catch { }
    [pscustomobject]@{ Processes = $procs; Windows = $windows; Any = ($procs.Count + $windows.Count) -gt 0 }
}

# Asks before closing anything (-Force: a silent uninstall, close them).
function Confirm-Close([string]$Path, [string[]]$Names) {
    if ($Force) { return $true }
    Add-Type -AssemblyName System.Windows.Forms
    $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; WindowState = 'Minimized' }
    $owner.Show(); $owner.Hide()
    $text = "These have files in $Path open, so it can't be deleted:`r`n`r`n  - $($Names -join "`r`n  - ")`r`n`r`nClose them and keep uninstalling? Anything unsaved in them is lost.`r`n`r`n(No: leave it, and delete the folder yourself after a restart.)"
    $answer = [System.Windows.Forms.MessageBox]::Show($owner, $text, 'Luma Arcade Uninstall', 'YesNo', 'Warning')
    $owner.Dispose()
    $answer -eq 'Yes'
}

function Remove-Folder([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return }
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $Path)) { return }

    $blockers = Get-Blockers $Path
    if ($blockers.Any) {
        $names = @($blockers.Processes | Group-Object ProcessName | ForEach-Object {
            $p = $_.Group[0]; $title = try { $p.MainModule.FileVersionInfo.FileDescription } catch { '' }
            if ($title) { "$title ($($p.ProcessName).exe)" } else { "$($p.ProcessName).exe" }
        })
        if ($blockers.Windows.Count) { $names += "File Explorer ($($blockers.Windows.Count) window$(if ($blockers.Windows.Count -gt 1) { 's' }) showing it)" }
        if (Confirm-Close $Path $names) {
            Write-Note "closing what had it open: $($names -join ', ')"
            foreach ($p in $blockers.Processes) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
            foreach ($w in $blockers.Windows) { try { $w.Quit() } catch { } }
        }
    }
    # Windows lets go of files a moment after a program closes.
    for ($i = 0; $i -lt 5 -and (Test-Path -LiteralPath $Path); $i++) {
        Start-Sleep -Seconds 1
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $Path) {
        Write-Note "couldn't delete all of $Path (something still has it open): delete it after a restart"
        $script:failed = $true
    }
}

# The uninstaller Windows lists for a program, newest first.
function Get-UninstallEntry([string]$NamePattern) {
    $keys = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    Get-ItemProperty $keys -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like $NamePattern -and $_.UninstallString } |
        Sort-Object { $_.DisplayVersion } -Descending
}

# Runs a program's own uninstaller with no windows: an MSI by its product
# code, anything else with the quiet switches given.
function Invoke-Uninstaller($Entry, [string[]]$QuietArgs) {
    # An MSI's product code: its registry key's name (WindowsInstaller = 1),
    # else the {GUID} in an msiexec command (often /I, which would open its
    # maintenance window, so it's always run as /x here).
    $product = $null
    if ($Entry.WindowsInstaller -eq 1 -and $Entry.PSChildName -match '^\{[0-9A-Fa-f-]{36}\}$') { $product = $Entry.PSChildName }
    elseif ($Entry.UninstallString -match 'msiexec' -and $Entry.UninstallString -match '(\{[0-9A-Fa-f-]{36}\})') { $product = $Matches[1] }
    if ($product) {
        $p = Start-Process msiexec.exe -ArgumentList '/x', $product, '/qn', '/norestart' -Wait -PassThru
    } else {
        $cmd = if ($Entry.QuietUninstallString) { $Entry.QuietUninstallString } else { $Entry.UninstallString }
        if ($cmd -match '^\s*"([^"]+)"\s*(.*)$') { $exe = $Matches[1]; $rest = $Matches[2] }
        else { $exe = ($cmd -split '\s+', 2)[0]; $rest = ($cmd -split '\s+', 2)[1] }
        $argList = @($rest) + $(if (-not $Entry.QuietUninstallString) { $QuietArgs }) | Where-Object { $_ }
        $p = Start-Process -FilePath $exe -ArgumentList $argList -Wait -PassThru
    }
    # 3010 = done, restart needed; 1605 = already gone.
    if ($p.ExitCode -notin 0, 1605, 3010) { throw "its uninstaller failed (exit code $($p.ExitCode))" }
    if ($p.ExitCode -eq 3010) { Write-Note 'Windows needs a restart to finish' }
}

# Driver packages (oemNN.inf) whose original .inf is this one.
function Get-DriverPackages([string]$InfName) {
    $published = $null
    foreach ($line in (& "$env:SystemRoot\System32\pnputil.exe" /enum-drivers)) {
        if ($line -match ':\s*(oem\d+\.inf)\s*$') { $published = $Matches[1] }
        elseif ($line -match ':\s*(\S+\.inf)\s*$' -and $published -and $Matches[1] -ieq $InfName) { $published; $published = $null }
    }
}

# --- emulators (before ES-DE: they can live inside its folder)

$wanted = @($Emulators -split '[,\s]+' | Where-Object { $_ } | ForEach-Object { $_.ToLowerInvariant() })
foreach ($key in $wanted) {
    if (-not $Catalog.Contains($key)) { Write-Note "unknown emulator '$key': skipped"; continue }
    $entry = $Catalog[$key]
    $short = $entry.Name -replace ' \(.*$', ''
    Write-Step "Removing $short"
    if ($GamesDir) {
        Remove-Folder (Join-Path $esdeDir "Emulators\$($entry.Folder)")
        Remove-Folder (Join-Path $GamesDir "Emulators\$($entry.Folder)")
    }
    $menu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Emulators'
    if (-not $TestRoot) { Remove-Item -Force (Join-Path $menu "$short.lnk") -ErrorAction SilentlyContinue }
}
foreach ($dir in @($(if ($GamesDir) { (Join-Path $esdeDir 'Emulators'), (Join-Path $GamesDir 'Emulators') }))) {
    if ((Test-Path $dir) -and -not (Get-ChildItem $dir -Force -ErrorAction SilentlyContinue)) { Remove-Item $dir -Force }
}
if (-not $TestRoot) {
    $menu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Emulators'
    if ((Test-Path $menu) -and -not (Get-ChildItem $menu -Force)) { Remove-Item $menu -Force }
}

# --- ES-DE

if ($EsDe) {
    Write-Step 'Removing ES-DE (your ROMs folder stays)'
    if ($esdeDir -and (Test-Path $esdeDir)) {
        $keep = @('ROMs', 'Emulators')
        Get-ChildItem -LiteralPath $esdeDir -Force | Where-Object { $_.Name -notin $keep } | ForEach-Object { Remove-Folder $_.FullName }
        if (-not (Get-ChildItem -LiteralPath $esdeDir -Force -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath $esdeDir -Force }
        else { Write-Note "kept $esdeDir\ROMs and any emulators still inside it" }
    }
    if (-not $TestRoot) { Remove-Item -Force (Join-Path $env:PUBLIC 'Desktop\ES-DE.lnk') -ErrorAction SilentlyContinue }
    # Each account's ES-DE folder: settings, game lists, favorites, the
    # event scripts and any scraped pictures.
    Get-ChildItem $profilesRoot -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
        $mine = Join-Path $_.FullName 'ES-DE'
        if (Test-Path (Join-Path $mine 'settings\es_settings.xml')) { Write-Note "its settings in $mine"; Remove-Folder $mine }
    }
    # Sunshine (when it stays) no longer lists it.
    if (-not $Sunshine -and (Test-Path $sunshineApps)) {
        $apps = Get-Content -Raw $sunshineApps | ConvertFrom-Json
        $left = @($apps.apps | Where-Object { $_.name -ne 'ES-DE' })
        if ($left.Count -ne @($apps.apps).Count) {
            Write-Note "taken off Sunshine's apps"
            $apps.apps = $left
            Copy-Item $sunshineApps "$sunshineApps.bak-luma-uninstall" -Force
            $apps | ConvertTo-Json -Depth 10 | Set-Content -Path $sunshineApps -Encoding UTF8
            if (-not $TestRoot) { Restart-Service SunshineService -Force -ErrorAction SilentlyContinue }
        }
    }
}

# --- Sunshine

if ($Sunshine) {
    Write-Step 'Removing Sunshine, with its settings and paired devices'
    try {
        if (-not $TestRoot) {
            Stop-Service SunshineService -Force -ErrorAction SilentlyContinue
            $entry = Get-UninstallEntry 'Sunshine*' | Select-Object -First 1
            if ($entry) { Invoke-Uninstaller $entry @('/S') } else { Write-Note "Windows doesn't list its uninstaller: deleting its folder" }
        }
        Remove-Folder $sunshineDir
    } catch {
        Write-Note "FAILED: $($_.Exception.Message). Remove it in Settings > Apps."
        $failed = $true
    }
}

# --- drivers

if ($VirtualDisplay) {
    Write-Step 'Removing the Virtual Display Driver'
    if (-not $TestRoot) {
        try {
            $devices = @(Get-CimInstance Win32_PnPEntity -Filter "PNPDeviceID LIKE 'ROOT\\DISPLAY\\%'" | Where-Object { $_.HardwareID -contains 'Root\MttVDD' })
            foreach ($d in $devices) {
                & "$env:SystemRoot\System32\pnputil.exe" /remove-device $d.PNPDeviceID | Out-Null
                if ($LASTEXITCODE -notin 0, 3010) { throw "pnputil couldn't remove the device (exit code $LASTEXITCODE)" }
            }
            foreach ($inf in @(Get-DriverPackages 'MttVDD.inf')) {
                & "$env:SystemRoot\System32\pnputil.exe" /delete-driver $inf /uninstall /force | Out-Null
            }
        } catch {
            Write-Note "FAILED: $($_.Exception.Message). Remove it in Device Manager > Display adapters."
            $failed = $true
        }
    }
    Remove-Folder $(if ($TestRoot) { Join-Path $TestRoot 'VirtualDisplayDriver' } else { 'C:\VirtualDisplayDriver' })
}

if ($ViGEm -and -not $TestRoot) {
    Write-Step 'Removing ViGEmBus (virtual controllers)'
    try {
        $entry = Get-UninstallEntry 'ViGEm Bus Driver*' | Select-Object -First 1
        if ($entry) { Invoke-Uninstaller $entry @('/qn', '/norestart') }
        else { Write-Note "Windows doesn't list it: nothing to remove" }
    } catch {
        Write-Note "FAILED: $($_.Exception.Message). Remove ""ViGEm Bus Driver"" in Settings > Apps."
        $failed = $true
    }
}

# --- the games folder, last (everything above may live in it)

if ($Games) {
    if ($GamesDir -and (Test-Path -LiteralPath $GamesDir)) {
        Write-Step "Deleting the games folder $GamesDir (games, saves, BIOS, ES-DE and emulators)"
        Remove-Folder $GamesDir
    }
    Write-Step "Deleting $dataDir (which player's saves are where)"
    Remove-Folder $dataDir
}

if ($failed) { exit 1 }
Write-Step 'Done'
