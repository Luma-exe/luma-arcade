# Windows-side setup for the installer (runs elevated):
#  -Server           Windows Server fixes: turns on the audio service (off by
#                    default there). The Xbox 360 driver it lacks is
#                    install-drivers.ps1's job.
#  -Account          the account LumaArcade and the games run under. Created
#                    if it doesn't exist (password read from -PasswordFile,
#                    which is deleted straight after unless -KeepPasswordFile:
#                    a file someone gave a silent install is theirs).
#  -AutoLogon        signs that account in when the PC starts (Sunshine can
#                    only stream a signed-in desktop). The password is kept
#                    as an LSA secret like Sysinternals Autologon does, not
#                    as plain text in the registry.
#  -LumaDir          LumaArcade's install folder: the account gets write
#                    access to it (its database lives there), and the
#                    firewall lets the home network reach the web page and
#                    browsers reach the stream's video directly.
#  -Autostart        start LumaArcade whenever the account signs in.
#  -Port             LumaArcade's port, for the firewall.
param(
    [switch]$Server,
    [string]$Account = '',
    [string]$PasswordFile = '',
    [switch]$KeepPasswordFile,
    [switch]$AutoLogon,
    [string]$LumaDir = '',
    [switch]$Autostart,
    [int]$Port = 7777
)
. (Join-Path $PSScriptRoot 'common.ps1')

$password = Read-SecretFile $PasswordFile -Keep:$KeepPasswordFile

if ($Server) {
    Write-Step 'Windows Server: turning on sound'
    foreach ($svc in 'AudioEndpointBuilder', 'Audiosrv') {
        Set-Service -Name $svc -StartupType Automatic
        Start-Service -Name $svc -ErrorAction SilentlyContinue
    }
}

if (-not $Account) { $Account = $env:USERNAME }
$isCurrent = $Account -ieq $env:USERNAME

if (-not $isCurrent) {
    $user = Get-LocalUser -Name $Account -ErrorAction SilentlyContinue
    if (-not $user) {
        if (-not $password) { throw "A password is needed to create the account $Account" }
        Write-Step "Creating the Windows account $Account"
        $secure = ConvertTo-SecureString $password -AsPlainText -Force
        New-LocalUser -Name $Account -Password $secure -FullName 'Luma Arcade' -Description 'Games and streaming (Luma Arcade)' -PasswordNeverExpires -AccountNeverExpires | Out-Null
        # A standard account: people streaming it can't change the PC.
        Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $Account
    } else {
        Write-Step "Using the existing Windows account $Account"
    }
}

if ($AutoLogon) {
    Write-Step "Signing $Account in automatically when the PC starts"
    Add-Type -AssemblyName System.DirectoryServices.AccountManagement
    $ctx = New-Object System.DirectoryServices.AccountManagement.PrincipalContext('Machine')
    $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    $current = Get-ItemProperty $winlogon
    if (-not $password -and $current.AutoAdminLogon -eq '1' -and $current.DefaultUserName -ieq $Account) {
        # An upgrade: already set up, and Setup wasn't given the password again.
        Write-Note 'already set up'
    } elseif (-not $password -or -not $ctx.ValidateCredentials($Account, $password)) {
        Write-Note "SKIPPED: that isn't $Account's password. Set it up later with Sysinternals Autologon."
    } else {
        Add-Type -Namespace LumaSetup -Name Lsa -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
[StructLayout(LayoutKind.Sequential)] public struct OBJECT_ATTRIBUTES { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
[DllImport("advapi32.dll")] public static extern uint LsaOpenPolicy(IntPtr SystemName, ref OBJECT_ATTRIBUTES ObjectAttributes, uint DesiredAccess, out IntPtr PolicyHandle);
[DllImport("advapi32.dll")] public static extern uint LsaStorePrivateData(IntPtr PolicyHandle, ref UNICODE_STRING KeyName, ref UNICODE_STRING PrivateData);
[DllImport("advapi32.dll")] public static extern uint LsaClose(IntPtr PolicyHandle);
[DllImport("advapi32.dll")] public static extern uint LsaNtStatusToWinError(uint Status);
public static UNICODE_STRING Str(string s) {
    var u = new UNICODE_STRING();
    u.Buffer = Marshal.StringToHGlobalUni(s);
    u.Length = (ushort)(s.Length * 2);
    u.MaximumLength = (ushort)(s.Length * 2 + 2);
    return u;
}
public static void StoreSecret(string name, string value) {
    var attrs = new OBJECT_ATTRIBUTES();
    IntPtr policy;
    uint status = LsaOpenPolicy(IntPtr.Zero, ref attrs, 0x00000020 /* POLICY_CREATE_SECRET */, out policy);
    if (status != 0) throw new System.ComponentModel.Win32Exception((int)LsaNtStatusToWinError(status));
    try {
        var key = Str(name);
        var data = Str(value);
        status = LsaStorePrivateData(policy, ref key, ref data);
        Marshal.FreeHGlobal(key.Buffer);
        Marshal.FreeHGlobal(data.Buffer);
        if (status != 0) throw new System.ComponentModel.Win32Exception((int)LsaNtStatusToWinError(status));
    } finally { LsaClose(policy); }
}
'@
        [LumaSetup.Lsa]::StoreSecret('DefaultPassword', $password)
        Set-ItemProperty $winlogon -Name AutoAdminLogon -Value '1'
        Set-ItemProperty $winlogon -Name DefaultUserName -Value $Account
        Set-ItemProperty $winlogon -Name DefaultDomainName -Value $env:COMPUTERNAME
        Remove-ItemProperty $winlogon -Name DefaultPassword -ErrorAction SilentlyContinue
    }
}
$password = $null

if ($LumaDir) {
    Write-Step "Letting $Account run Luma Arcade from $LumaDir"
    & icacls.exe $LumaDir /grant "${Account}:(OI)(CI)M" /T /C /Q | Out-Null

    Write-Step 'Firewall: the Luma Arcade page (home network) and stream video'
    Remove-NetFirewallRule -DisplayName 'Luma Arcade web page' -ErrorAction SilentlyContinue
    Remove-NetFirewallRule -DisplayName 'Luma Arcade stream video' -ErrorAction SilentlyContinue
    # Settings > General can change the port later (then change this rule too).
    New-NetFirewallRule -DisplayName 'Luma Arcade web page' -Direction Inbound -Protocol TCP -LocalPort $Port -Profile Domain, Private -Action Allow | Out-Null
    # Without this, WebRTC video can't come straight in and goes through a
    # relay (slower) or falls back to the WebSocket.
    New-NetFirewallRule -DisplayName 'Luma Arcade stream video' -Direction Inbound -Protocol UDP -Program (Join-Path $LumaDir 'moonlight-web-stream\streamer.exe') -Action Allow | Out-Null
}

if ($LumaDir -and $Autostart) {
    Write-Step "Starting Luma Arcade whenever $Account signs in"
    $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$LumaDir\LumaArcade.vbs`" --background" -WorkingDirectory $LumaDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:COMPUTERNAME\$Account"
    $principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$Account" -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName 'LumaArcade' -TaskPath '\LumaArcade\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}

Write-Step 'Windows setup done'
