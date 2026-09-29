# Lets other devices use Luma Arcade properly (runs elevated). Browsers only
# allow game controllers and full screen on HTTPS pages (or localhost), so
# a TV or laptop opening http://<this PC>:7777 can't use a controller.
#  -HttpsPort        HTTPS on the home network: a certificate made for this
#                    PC (self-signed: each device shows a warning once, or
#                    trusts it for good by installing luma-arcade.cer from
#                    http://<this PC>:7777/luma-arcade.cer). Luma Arcade
#                    serves both. 0 = off.
#  -TunnelTokenFile  a Cloudflare Tunnel token (Cloudflare dashboard > Zero
#                    Trust > Networks > Tunnels > create one, copy the token
#                    from its install command). Installs cloudflared as a
#                    service; point the tunnel's public hostname at
#                    http://localhost:7777 in the dashboard. The file is
#                    deleted after reading unless -KeepTokenFile.
#  -Account          the account Luma Arcade runs as (reads the key)
param(
    [Parameter(Mandatory)] [string]$LumaDir,
    [int]$HttpsPort = 0,
    [string]$TunnelTokenFile = '',
    [switch]$KeepTokenFile,
    [string]$Account = '',
    [switch]$Latest
)
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'catalog.ps1')

if (-not $Account) { $Account = $env:USERNAME }
$failed = $false

if ($HttpsPort) {
    Write-Step "HTTPS on the home network (port $HttpsPort)"
    try {
        $dir = Join-Path $LumaDir 'server\https'
        $configFile = Join-Path $LumaDir 'server\https.json'
        $pfx = Join-Path $dir 'luma.pfx'
        $keep = $false
        if ((Test-Path $configFile) -and (Test-Path $pfx)) {
            # Upgrading: keep the certificate devices already accepted, until it's nearly expired.
            $old = Get-Content -Raw $configFile | ConvertFrom-Json
            $cert = New-Object Security.Cryptography.X509Certificates.X509Certificate2($pfx, $old.passphrase)
            $keep = $cert.NotAfter -gt (Get-Date).AddDays(30)
        }
        if ($keep) {
            Write-Note "keeping the certificate (valid until $($cert.NotAfter.ToString('yyyy-MM-dd')))"
            $old.port = $HttpsPort
            $old | ConvertTo-Json | Set-Content -Path $configFile -Encoding UTF8
        } else {
            New-Item -ItemType Directory -Force $dir | Out-Null
            $names = @($env:COMPUTERNAME, "$env:COMPUTERNAME.local", 'localhost')
            $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } | ForEach-Object IPAddress) + '127.0.0.1'
            $san = (@($names | ForEach-Object { "DNS=$_" }) + @($ips | ForEach-Object { "IPAddress=$_" })) -join '&'
            # 820 days: the longest Apple devices accept for a certificate they trust.
            $cert = New-SelfSignedCertificate -Subject "CN=Luma Arcade ($env:COMPUTERNAME)" -FriendlyName 'Luma Arcade' `
                -TextExtension @("2.5.29.17={text}$san", '2.5.29.37={text}1.3.6.1.5.5.7.3.1') `
                -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable `
                -NotAfter (Get-Date).AddDays(820) -CertStoreLocation 'Cert:\LocalMachine\My'
            $bytes = New-Object byte[] 24
            [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
            $passphrase = [Convert]::ToBase64String($bytes)
            $secure = ConvertTo-SecureString $passphrase -AsPlainText -Force
            Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $secure | Out-Null
            Export-Certificate -Cert $cert -FilePath (Join-Path $dir 'luma-arcade.cer') | Out-Null
            Remove-Item -Path "Cert:\LocalMachine\My\$($cert.Thumbprint)"
            [ordered]@{ port = $HttpsPort; pfx = 'https\luma.pfx'; passphrase = $passphrase; cert = 'https\luma-arcade.cer' } |
                ConvertTo-Json | Set-Content -Path $configFile -Encoding UTF8
            Write-Note "certificate for $($names -join ', '), $($ips -join ', ')"
        }
        # The key: only administrators, SYSTEM and the account Luma Arcade runs as.
        & icacls.exe $dir /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' "${Account}:(OI)(CI)R" /T /C /Q | Out-Null
        & icacls.exe $configFile /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' "${Account}:R" /C /Q | Out-Null
        Remove-NetFirewallRule -DisplayName 'Luma Arcade web page (HTTPS)' -ErrorAction SilentlyContinue
        New-NetFirewallRule -DisplayName 'Luma Arcade web page (HTTPS)' -Direction Inbound -Protocol TCP -LocalPort $HttpsPort -Profile Domain, Private -Action Allow | Out-Null
        Write-Note "other devices: https://$($env:COMPUTERNAME):$HttpsPort (accept the certificate warning once)"
    } catch {
        Write-Note "FAILED: $($_.Exception.Message)"
        $failed = $true
    }
}

$token = Read-SecretFile $TunnelTokenFile -Keep:$KeepTokenFile
if ($token) {
    Write-Step 'Cloudflare Tunnel (play from outside the home network)'
    try {
        $svc = Get-CimInstance Win32_Service -Filter "Name='Cloudflared'"
        if ($svc) {
            Write-Note "cloudflared is already installed as a service ($($svc.PathName)): keeping it"
        } else {
            $dir = Join-Path $LumaDir 'cloudflared'
            New-Item -ItemType Directory -Force $dir | Out-Null
            $src = Get-CatalogDownload 'cloudflared' -Latest:$Latest
            $file = Save-CatalogDownload 'cloudflared' $src
            $exe = Join-Path $dir 'cloudflared.exe'
            Move-Item -Force $file $exe
            # cloudflared only takes the token on its command line here.
            $p = Start-Process -FilePath $exe -ArgumentList 'service', 'install', (ConvertTo-Argument $token) -WindowStyle Hidden -Wait -PassThru
            if ($p.ExitCode) { throw "cloudflared service install failed (exit code $($p.ExitCode)) - is the token right?" }
            Write-Note "installed ($($src.Version)). In the Cloudflare dashboard, give the tunnel a public hostname pointing at http://localhost:7777"
        }
    } catch {
        Write-Note "FAILED: $($_.Exception.Message)"
        $failed = $true
    }
}
$token = $null

if ($failed) { exit 1 }
Write-Step 'Network setup done'
