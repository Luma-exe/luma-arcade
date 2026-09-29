# Installs Sunshine (the streaming host) from its latest official release,
# unless it's already installed, and lists ES-DE as a Sunshine app.
#  -EsDeExe   ES-DE.exe to add as an app (skipped if Sunshine already has one)
#  -Ds4       make Sunshine's virtual controllers PS4 pads instead of Xbox 360
#             ones (for Windows Server without the Xbox 360 driver)
param(
    [string]$EsDeExe = '',
    [switch]$Ds4
)
. (Join-Path $PSScriptRoot 'common.ps1')

$sunshineDir = Join-Path $env:ProgramFiles 'Sunshine'
$configDir = Join-Path $sunshineDir 'config'

if (Get-Service -Name SunshineService -ErrorAction SilentlyContinue) {
    Write-Step 'Sunshine is already installed: keeping it'
} else {
    Write-Step 'Sunshine (streams this PC''s screen, sound and controllers)'
    $asset = Get-GitHubAsset 'LizardByte/Sunshine' 'Windows-AMD64-installer\.msi$'
    Write-Note "$($asset.Name) ($($asset.Version))"
    $msi = Save-Download $asset.Url $asset.Name
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

# Sunshine only rereads its config when its service restarts.
if ($changed) { Restart-Service SunshineService -Force -ErrorAction SilentlyContinue }

Write-Step 'Sunshine done. Open https://localhost:47990 once to set its admin name and password.'
