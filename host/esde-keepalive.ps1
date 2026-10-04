<#
  What Sunshine's ES-DE app starts, instead of ES-DE.exe itself:

    conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass
      -File C:\ProgramData\LumaArcade\esde-keepalive.ps1 -Exe "G:\ES-DE\ES-DE.exe"

  ES-DE's menu has "Quit ES-DE", which left the player looking at the games
  PC's desktop (and ended the stream, since ES-DE was the app). Now when
  ES-DE quits while someone is streaming, it is started again.

  Sunshine closing the app (Stop, the website closing a game nobody came back
  to, or making room for another player's saves) also quits ES-DE first. It
  logs "Successfully requested the app to exit" when it does, and ends this
  script within its exit timeout (5 seconds). So after ES-DE quits, this
  checks Sunshine's log: Sunshine closing it -> leave it closed; otherwise
  start it again at once. If the log can't be read, it waits out the exit
  timeout instead. Nobody streaming any more (no moonlight streamer.exe)
  -> leave it closed too.
#>
param([string]$Exe)

$LOG = 'C:\ProgramData\LumaArcade\home\esde-keepalive.log'
function Log($m) { try { Add-Content $LOG "$(Get-Date -Format s) $m" } catch {} }

if (-not $Exe) {
  $Exe = 'G:\ES-DE\ES-DE.exe'
  $hostFile = 'C:\ProgramData\LumaArcade\host.json'
  try { if (Test-Path $hostFile) { $h = Get-Content -Raw $hostFile | ConvertFrom-Json; if ($h.esDe) { $Exe = $h.esDe } } } catch {}
}
$Exe = $Exe.Trim('"')
$name = [IO.Path]::GetFileNameWithoutExtension($Exe)

$SUNSHINE_LOG = 'C:\Program Files\Sunshine\config\sunshine.log'
$RESTART_DELAY = 7      # seconds; more than Sunshine's exit timeout
$QUICK_EXIT = 15        # seconds; ES-DE quitting sooner than this ...
$MAX_QUICK = 3          # ... this many times in a row means it can't start

# An ES-DE left open outside Sunshine (the Home button starts one when it
# isn't running) is closed first: Sunshine only closes what it started, and
# the next player's saves can't be swapped in while ES-DE is open.
foreach ($stray in @(Get-Process $name -ErrorAction SilentlyContinue)) {
  [void]$stray.CloseMainWindow()
  if (-not $stray.WaitForExit(15000)) { Stop-Process -Id $stray.Id -Force -ErrorAction SilentlyContinue }
  Log "closed an ES-DE that was open outside the stream (pid $($stray.Id))"
}

# Whether Sunshine asked the app to exit at or after $since: $true / $false,
# or $null when its log can't be read.
function Test-SunshineClosing([datetime]$since) {
  try {
    $stream = [IO.File]::Open($SUNSHINE_LOG, 'Open', 'Read', 'ReadWrite, Delete')
    try {
      $stream.Seek([Math]::Max(0, $stream.Length - 65536), 'Begin') | Out-Null
      $tail = (New-Object IO.StreamReader($stream)).ReadToEnd()
    } finally { $stream.Dispose() }
  } catch { return $null }
  foreach ($m in [regex]::Matches($tail, '\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\.\d+\]: Info: Successfully requested the app to exit')) {
    $at = [datetime]::ParseExact($m.Groups[1].Value, 'yyyy-MM-dd HH:mm:ss', $null)
    if ($at -ge $since.AddSeconds(-2)) { return $true }
  }
  return $false
}

$quick = 0
while ($true) {
  # One started in the meantime (the Home button) is kept, not doubled.
  $es = Get-Process $name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $es) {
    try { $es = Start-Process -FilePath $Exe -WorkingDirectory (Split-Path $Exe) -PassThru -ErrorAction Stop }
    catch { Log "couldn't start ${Exe}: $($_.Exception.Message)"; exit 1 }
  }
  $started = Get-Date
  $es.WaitForExit()
  $code = try { $es.ExitCode } catch { 0 }
  $ran = ((Get-Date) - $started).TotalSeconds

  # Sunshine logs its request before ES-DE has even closed; a moment more
  # lets the line reach the file.
  Start-Sleep -Seconds 1
  $closing = Test-SunshineClosing $started.AddSeconds($ran)
  if ($closing) { Log "Sunshine is closing ES-DE; leaving it closed"; exit $code }
  if ($null -eq $closing) { Start-Sleep -Seconds ($RESTART_DELAY - 1) }
  if (-not (Get-Process streamer -ErrorAction SilentlyContinue)) {
    Log "ES-DE quit (code $code) with nobody streaming; letting the app end"
    exit $code
  }
  if ($ran -lt $QUICK_EXIT) { $quick++ } else { $quick = 0 }
  if ($quick -ge $MAX_QUICK) {
    Log "ES-DE quit $quick times in a row within $QUICK_EXIT seconds; giving up"
    exit $code
  }
  Log "ES-DE quit (code $code, after $([int]$ran) s) while someone is streaming; starting it again"
}
