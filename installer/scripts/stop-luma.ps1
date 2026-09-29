# Stops the Luma Arcade installed in -LumaDir before an upgrade replaces its
# files (a running node.exe can't be overwritten). Its database, moonlight's
# data.json (accounts, paired PCs) and settings are left alone.
#  -CheckOnly   change nothing, just report
# Exit code: 0 = wasn't running, 2 = was running, 3 = was running and
# someone was streaming (their stream drops).
param(
    [Parameter(Mandatory)] [string]$LumaDir,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'SilentlyContinue'

$root = (Resolve-Path $LumaDir).Path.TrimEnd('\') + '\'
$ours = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) })
$running = [bool]($ours | Where-Object { $_.Name -in 'node.exe', 'web-server.exe' })
$streaming = [bool]($ours | Where-Object { $_.Name -eq 'streamer.exe' })
$code = if ($streaming) { 3 } elseif ($running) { 2 } else { 0 }
if ($CheckOnly -or -not $ours) { exit $code }

Write-Output "==> Stopping Luma Arcade for the upgrade"
& schtasks.exe /end /tn '\LumaArcade\LumaArcade' 2>$null | Out-Null
# node.exe first, so it doesn't restart moonlight-web-stream behind us. (The
# tunnel's cloudflared.exe isn't replaced by an upgrade: it keeps running.)
$files = 'node.exe', 'web-server.exe', 'streamer.exe'
foreach ($name in $files) {
    foreach ($p in $ours | Where-Object Name -eq $name) { Stop-Process -Id $p.ProcessId -Force }
}
for ($i = 0; $i -lt 20; $i++) {
    $left = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in $files -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) })
    if (-not $left) { break }
    Start-Sleep -Milliseconds 500
}
exit $code
