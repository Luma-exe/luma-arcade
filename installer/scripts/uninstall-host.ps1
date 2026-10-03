# Undoes install-host.ps1 and setup-network.ps1 when Luma Arcade is
# uninstalled (runs elevated):
#  - the scheduled tasks, the helper scripts and host.json in
#    C:\ProgramData\LumaArcade (its home\ and profiles\ folders stay: they
#    record whose saves are in which folder);
#  - the Sunshine prep-cmds that ran them (Sunshine would otherwise refuse to
#    start ES-DE, its prep-cmd failing) and the ES-DE event scripts;
#  - the Cloudflare Tunnel service Setup installed.
# Asked for on the uninstaller's options page:
#  -RemoveAutoLogon  stop signing -Account in when the PC starts
#  -RemoveAccount    delete the -Account Windows account and its files
#  -AccountOnly      only the two above (Luma Arcade itself stays)
#  -TestRoot         testing: ProgramData and Sunshine's apps.json under this
#                    folder instead; no tasks, services or accounts touched
param(
    [string]$LumaDir = '',
    [string]$Account = '',
    [switch]$RemoveAutoLogon,
    [switch]$RemoveAccount,
    [switch]$AccountOnly,
    [string]$TestRoot = ''
)
. (Join-Path $PSScriptRoot 'common.ps1')
$ErrorActionPreference = 'Continue'

$dataDir = 'C:\ProgramData\LumaArcade'
$sunshineApps = Join-Path $env:ProgramFiles 'Sunshine\config\apps.json'
if ($TestRoot) {
    $dataDir = Join-Path $TestRoot 'LumaArcade'; $sunshineApps = Join-Path $TestRoot 'apps.json'
    $LumaDir = ''; $RemoveAutoLogon = $false; $RemoveAccount = $false
}
$hostFile = Join-Path $dataDir 'host.json'
$hostConfig = if (Test-Path $hostFile) { Get-Content -Raw $hostFile | ConvertFrom-Json } else { $null }

if (-not $AccountOnly) {
Write-Step 'Removing the scheduled tasks'
# Every task Setup made (LumaArcade, Home, Lockdown, PC Games), so the
# \LumaArcade folder can go too.
if (-not $TestRoot) {
    Get-ScheduledTask -TaskPath '\LumaArcade\' -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue
}
if (-not $TestRoot) {
    try {
        $scheduler = New-Object -ComObject Schedule.Service
        $scheduler.Connect()
        $folder = $scheduler.GetFolder('\LumaArcade')
        if ($folder.GetTasks(1).Count -eq 0 -and $folder.GetFolders(0).Count -eq 0) { $scheduler.GetFolder('\').DeleteFolder('LumaArcade', 0) }
    } catch { }
}

if (Test-Path $sunshineApps) {
    $apps = Get-Content -Raw $sunshineApps | ConvertFrom-Json
    $changed = $false
    foreach ($app in $apps.apps) {
        # ES-DE back to starting ES-DE.exe itself, not esde-keepalive.ps1.
        if ($app.cmd -match 'esde-keepalive\.ps1.*-Exe\s+"([^"]+)"') {
            Write-Step "Sunshine: $($app.name) starts $($Matches[1]) itself again"
            $app.cmd = $Matches[1]
            $changed = $true
        }
        $prep = @($app.'prep-cmd' | Where-Object { $_ })
        if (-not ($prep | Where-Object { $_.do -like "*$dataDir\*" })) { continue }
        Write-Step "Sunshine: $($app.name) no longer runs Luma Arcade's scripts"
        # Keep an entry that also undoes something (Big Picture's close).
        $kept = @(foreach ($p in $prep) {
            if ($p.do -notlike "*$dataDir\*") { $p }
            elseif ($p.undo) { $p.do = ''; $p }
        })
        $app | Add-Member -NotePropertyName 'prep-cmd' -NotePropertyValue $kept -Force
        $changed = $true
    }
    if ($changed) {
        Copy-Item $sunshineApps "$sunshineApps.bak-luma-uninstall" -Force
        $apps | ConvertTo-Json -Depth 10 | Set-Content -Path $sunshineApps -Encoding UTF8
        if (-not $TestRoot) { Restart-Service SunshineService -Force -ErrorAction SilentlyContinue }
    }
}

if ($hostConfig -and $hostConfig.gamelists) {
    $events = Join-Path (Split-Path $hostConfig.gamelists) 'scripts\game-start'
    foreach ($bat in '00-emulator-window.bat', '01-minimize-es-de.bat', '02-luma-game-events.bat') {
        Remove-Item -Force (Join-Path $events $bat) -ErrorAction SilentlyContinue
    }
}

Write-Step "Removing the helper scripts from $dataDir (keeping its home and profiles folders)"
Get-ChildItem $dataDir -Filter *.ps1 -ErrorAction SilentlyContinue | Remove-Item -Force
Remove-Item -Force $hostFile -ErrorAction SilentlyContinue

# The tunnel service, if it's the cloudflared Setup put in the install folder.
$tunnel = if ($TestRoot) { $null } else { Get-CimInstance Win32_Service -Filter "Name='Cloudflared'" }
$ourCloudflared = if ($LumaDir) { Join-Path $LumaDir 'cloudflared\cloudflared.exe' } else { $null }
if ($tunnel -and $ourCloudflared -and $tunnel.PathName -like "*$ourCloudflared*") {
    Write-Step 'Removing the Cloudflare Tunnel service'
    & $ourCloudflared service uninstall 2>&1 | Out-Null
}
} # -AccountOnly

if ($RemoveAutoLogon -and $Account) {
    $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    $current = Get-ItemProperty $winlogon
    if ($current.AutoAdminLogon -eq '1' -and $current.DefaultUserName -ieq $Account) {
        Write-Step "No longer signing $Account in when the PC starts"
        Set-ItemProperty $winlogon -Name AutoAdminLogon -Value '0'
        Remove-ItemProperty $winlogon -Name DefaultPassword -ErrorAction SilentlyContinue
        # The password Setup stored as an LSA secret: storing nothing deletes it.
        Add-Type -Namespace LumaSetup -Name LsaRemove -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
[StructLayout(LayoutKind.Sequential)] public struct OBJECT_ATTRIBUTES { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
[DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr SystemName, ref OBJECT_ATTRIBUTES ObjectAttributes, uint DesiredAccess, out IntPtr PolicyHandle);
[DllImport("advapi32.dll")] static extern uint LsaStorePrivateData(IntPtr PolicyHandle, ref UNICODE_STRING KeyName, IntPtr PrivateData);
[DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr PolicyHandle);
public static uint RemoveSecret(string name) {
    var attrs = new OBJECT_ATTRIBUTES();
    IntPtr policy;
    uint status = LsaOpenPolicy(IntPtr.Zero, ref attrs, 0x00000020 /* POLICY_CREATE_SECRET */, out policy);
    if (status != 0) return status;
    try {
        var key = new UNICODE_STRING();
        key.Buffer = Marshal.StringToHGlobalUni(name);
        key.Length = (ushort)(name.Length * 2);
        key.MaximumLength = (ushort)(name.Length * 2 + 2);
        status = LsaStorePrivateData(policy, ref key, IntPtr.Zero);
        Marshal.FreeHGlobal(key.Buffer);
        return status;
    } finally { LsaClose(policy); }
}
'@
        [void][LumaSetup.LsaRemove]::RemoveSecret('DefaultPassword')
    } else {
        Write-Note "$Account isn't signed in automatically: nothing to change"
    }
}

if ($RemoveAccount -and $Account -and $Account -ine $env:USERNAME) {
    $user = Get-LocalUser -Name $Account -ErrorAction SilentlyContinue
    if ($user) {
        Write-Step "Deleting the Windows account $Account and its files"
        # Signed in (it may sign in by itself): sign it out first, or its
        # files are in use.
        $sessions = & quser.exe 2>$null | Select-Object -Skip 1 | Where-Object { $_ -match "^\s*>?$([regex]::Escape($Account))\s" }
        foreach ($line in $sessions) {
            $id = [regex]::Match($line, '\s(\d+)\s+(Active|Disc)').Groups[1].Value
            if ($id) { & logoff.exe $id 2>$null }
        }
        Start-Sleep -Seconds 5
        $sid = $user.SID.Value
        Remove-LocalUser -Name $Account
        $profile = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid }
        if ($profile) {
            try { $profile | Remove-CimInstance -ErrorAction Stop }
            catch { Write-Note "Couldn't delete $($profile.LocalPath) ($($_.Exception.Message)): delete it after a restart" }
        }
    }
}

Write-Step 'PC-side setup removed'
