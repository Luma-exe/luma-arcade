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
#                    access only to the few folders the app writes at run
#                    time (its database, moonlight-web-stream's data.json),
#                    never to the programs run elevated (Uninstall.exe,
#                    cloudflared.exe). The firewall lets the home network
#                    reach the web page and browsers reach the stream's
#                    video directly.
#  -CheckAdminOnly   changes nothing: exits 3 if -Account is a Windows
#                    administrator, else 0 (the installer asks first).
#  -RemoveFromAdmins takes an existing -Account out of Administrators, so
#                    people streaming its desktop can't take over the PC.
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
    [int]$Port = 7777,
    [switch]$CheckAdminOnly,
    [switch]$RemoveFromAdmins
)
. (Join-Path $PSScriptRoot 'common.ps1')

# True if $Name is in Administrators (S-1-5-32-544). By SID, so it works
# whatever language Windows is in; false if the account doesn't exist.
function Test-IsAdministrator([string]$Name) {
    try {
        Add-Type -AssemblyName System.DirectoryServices.AccountManagement
        $ctx = New-Object System.DirectoryServices.AccountManagement.PrincipalContext('Machine')
        $idType = [System.DirectoryServices.AccountManagement.IdentityType]
        $user = [System.DirectoryServices.AccountManagement.UserPrincipal]::FindByIdentity($ctx, $idType::SamAccountName, $Name)
        if (-not $user) { return $false }
        $group = [System.DirectoryServices.AccountManagement.GroupPrincipal]::FindByIdentity($ctx, $idType::Sid, 'S-1-5-32-544')
        return [bool]$user.IsMemberOf($group)
    } catch {
        return $false
    }
}

if ($CheckAdminOnly) {
    if (-not $Account) { $Account = $env:USERNAME }
    if (Test-IsAdministrator $Account) { exit 3 }
    exit 0
}

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

# Anyone streaming the games account sees and controls its desktop, so an
# administrator account there means control of the whole PC.
if (Test-IsAdministrator $Account) {
    if ($RemoveFromAdmins -and -not $isCurrent) {
        Write-Step "Taking $Account out of the Administrators group"
        Remove-LocalGroupMember -SID 'S-1-5-32-544' -Member $Account
        Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $Account -ErrorAction SilentlyContinue
        Write-Note "$Account is now a standard account"
    } else {
        if ($RemoveFromAdmins) { Write-Note "Not changing $Account's rights: it's the account running Setup, and taking it out of Administrators would lock you out" }
        Write-Warn "$Account is a Windows administrator. Players streaming its desktop could take over the PC. Use a separate standard account."
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
    # Only what the app writes while it runs. The rest of the folder stays
    # read and run only: Uninstall.exe is run elevated by administrators and
    # cloudflared.exe runs as a SYSTEM service, so a games account that could
    # change them could take over the PC.
    # An older Setup gave this account Modify on the whole folder: take that
    # back first (only what was granted to the account by name).
    & icacls.exe $LumaDir /remove:g $Account /T /C /Q | Out-Null
    # server\: the database (luma-arcade.db, with its -wal and -shm files).
    # SQLite creates those next to it, so that one folder and the files directly
    # in it are writable. (NP) = no propagate: the files inherit it, but dist    # and node_modules\ (and what is in them) don't, so they stay read-only.
    # moonlight-web-stream\server\: data.json (users, paired PCs) and its
    # backup, rewritten whenever someone is added or a PC is paired.
    $writable = @(
        @{ Path = Join-Path $LumaDir 'server'; Grant = @("${Account}:(M)", "${Account}:(OI)(IO)(NP)M") },
        @{ Path = Join-Path $LumaDir 'moonlight-web-stream\server'; Grant = @("${Account}:(OI)(CI)M") }
    )
    foreach ($w in $writable) {
        New-Item -ItemType Directory -Force $w.Path | Out-Null
        foreach ($g in $w.Grant) { & icacls.exe $w.Path /grant $g /C /Q | Out-Null }
    }

    Write-Step 'Firewall: the Luma Arcade page (home network) and stream video'
    Remove-NetFirewallRule -DisplayName 'Luma Arcade web page' -ErrorAction SilentlyContinue
    Remove-NetFirewallRule -DisplayName 'Luma Arcade stream video' -ErrorAction SilentlyContinue
    # Settings > General can change the port later (then change this rule too).
    New-NetFirewallRule -DisplayName 'Luma Arcade web page' -Direction Inbound -Protocol TCP -LocalPort $Port -Profile Domain, Private -RemoteAddress LocalSubnet -Action Allow | Out-Null
    # Without this, WebRTC video can't come straight in and goes through a
    # relay (slower) or falls back to the WebSocket.
    # Deliberately NOT limited to the home network (no -RemoteAddress): the
    # players' browsers connect to this from the internet, from addresses
    # nobody can list in advance. It stays bound to streamer.exe, which only
    # listens while a stream runs.
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
