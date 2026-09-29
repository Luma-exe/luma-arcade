# Installs Sunshine (the streaming host), unless it's already installed, and
# lists ES-DE as a Sunshine app.
#  -EsDeExe   ES-DE.exe to add as an app (skipped if Sunshine already has one)
#  -Ds4       make Sunshine's virtual controllers PS4 pads instead of Xbox 360
#             ones (for Windows Server without the Xbox 360 driver)
#  -AdminFile the admin's name and password (two lines): Sunshine's web page
#             sign-in, set when Sunshine doesn't have one yet (the file is
#             left for the pairing step, first-run.mjs)
#  -Latest    the newest Sunshine instead of the tested version
param(
    [string]$EsDeExe = '',
    [switch]$Ds4,
    [string]$AdminFile = '',
    [switch]$Latest
)
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'catalog.ps1')

$sunshineDir = Join-Path $env:ProgramFiles 'Sunshine'
$configDir = Join-Path $sunshineDir 'config'

if (Get-Service -Name SunshineService -ErrorAction SilentlyContinue) {
    Write-Step 'Sunshine is already installed: keeping it'
} else {
    Write-Step 'Sunshine (streams this PC''s screen, sound and controllers)'
    $src = Get-CatalogDownload 'sunshine' -Latest:$Latest
    Write-Note "$($src.Name) ($($src.Version)$(if (-not $src.Pinned) { ', newest' }))"
    $msi = Save-CatalogDownload 'sunshine' $src
    $p = Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/qn', '/norestart' -Wait -PassThru
    Remove-Item -Force $msi
    # 3010 = installed, restart needed later.
    if ($p.ExitCode -notin 0, 3010) { throw "Sunshine's installer failed (exit code $($p.ExitCode))" }
}

# Sunshine writes its config files the first time its service runs.
Start-Service SunshineService -ErrorAction SilentlyContinue
$appsFile = Join-Path $configDir 'apps.json'
for ($i = 0; $i -lt 30 -and -not (Test-Path $appsFile); $i++) { Start-Sleep -Seconds 1 }

$changed = $false
if ($EsDeExe -and (Test-Path $appsFile)) {
    $apps = Get-Content -Raw $appsFile | ConvertFrom-Json
    if (-not ($apps.apps | Where-Object { $_.name -eq 'ES-DE' })) {
        Write-Step 'Adding ES-DE to Sunshine''s apps'
        $entry = [pscustomobject]@{
            name          = 'ES-DE'
            cmd           = "`"$EsDeExe`""
            'working-dir' = (Split-Path $EsDeExe)
            'auto-detach' = 'true'
            'wait-all'    = 'true'
            'exit-timeout'= '5'
        }
        $apps.apps = @($apps.apps) + $entry
        Copy-Item $appsFile "$appsFile.bak-luma-setup" -Force
        $apps | ConvertTo-Json -Depth 10 | Set-Content -Path $appsFile -Encoding UTF8
        $changed = $true
    }
} elseif ($EsDeExe) {
    Write-Note "Sunshine hasn't written apps.json yet: add ES-DE ($EsDeExe) in Sunshine's web page > Applications."
}

if ($Ds4) {
    $conf = Join-Path $configDir 'sunshine.conf'
    $lines = @(if (Test-Path $conf) { Get-Content $conf | Where-Object { $_ -notmatch '^\s*gamepad\s*=' } })
    Write-Step 'Sunshine: PS4 controller emulation (works without the Xbox 360 driver)'
    ($lines + 'gamepad = ds4') | Set-Content -Path $conf -Encoding ASCII
    $changed = $true
}

$signIn = $false
$admin = $null
$lines = @(Read-SecretFile $AdminFile -Keep) -split "`r?`n"
if ($lines.Count -ge 2 -and $lines[0] -and $lines[1]) { $admin = [pscustomobject]@{ name = $lines[0]; password = $lines[1] } }
$lines = $null
if ($admin) {
    $state = Join-Path $configDir 'sunshine_state.json'
    $hasUser = (Test-Path $state) -and [bool](Get-Content -Raw $state | ConvertFrom-Json).username
    if ($hasUser) {
        Write-Note 'Sunshine already has a sign-in: keeping it'
    } else {
        Write-Step "Sunshine's web page sign-in: $($admin.name)"
        $p = Start-Process -FilePath (Join-Path $sunshineDir 'sunshine.exe') -ArgumentList '--creds', (ConvertTo-Argument $admin.name), (ConvertTo-Argument $admin.password) `
            -WorkingDirectory $sunshineDir -WindowStyle Hidden -Wait -PassThru
        if ($p.ExitCode) { Write-Note "FAILED (exit code $($p.ExitCode)): set it at https://localhost:47990" } else { $changed = $true; $signIn = $true }
    }
}
$admin = $null

# Sunshine only rereads its config when its service restarts.
if ($changed) { Restart-Service SunshineService -Force -ErrorAction SilentlyContinue }

if ($signIn -or $hasUser) { Write-Step 'Sunshine done.' }
else { Write-Step 'Sunshine done. Open https://localhost:47990 once to set its admin name and password.' }
