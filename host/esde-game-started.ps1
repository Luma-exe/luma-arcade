<#
  ES-DE game-start event script (called by
  C:\Users\Arcade\ES-DE\scripts\game-start\01-minimize-es-de.bat).

  ES-DE runs in the background while a game plays (RunInBackground, and
  Steam/Epic launches return straight away). If Windows hands focus back to
  it for a moment - a launcher or overlay closing - it picks up the stick
  direction being held, then never sees it released once the game takes
  focus again, and scrolls sideways forever behind the game.

  So once the game (or its launcher) is really in front, minimize ES-DE: a
  minimized window never gets focus back by accident. When the game closes
  and only the desktop is left, bring ES-DE back. The stream's Home button
  (home.ps1) restores ES-DE by itself; then this just stops.

  Relaunches itself hidden and returns at once, since ES-DE waits for event
  scripts before launching the game.
#>
param([switch]$Wait)

if (-not $Wait) {
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$PSCommandPath`"", '-Wait')
  exit 0
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class LumaGame {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);

  public static string ClassOf(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static void Minimize(IntPtr h) { if (!IsIconic(h)) ShowWindowAsync(h, 6); }
  public static void Restore(IntPtr h) {
    if (IsIconic(h)) ShowWindowAsync(h, 9);
    // A synthetic Alt press lets a background process hand out focus.
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    BringWindowToTop(h);
    SetForegroundWindow(h);
  }
}
"@

$LOG = 'C:\ProgramData\LumaArcade\home\esde-game-start.log'
function Log($m) { try { Add-Content $LOG "$(Get-Date -Format s) $m" } catch {} }

# Windows that aren't the game: the desktop, taskbar, Steam's own client
# (its "launching" dialog), and our own helpers.
$NOT_GAME = 'explorer', 'ShellExperienceHost', 'StartMenuExperienceHost', 'SearchHost', 'sunshine', 'sunshinesvc',
  'powershell', 'conhost', 'cmd', 'steam', 'steamwebhelper', 'EpicGamesLauncher', 'EpicWebHelper', 'ES-DE'
$DESKTOP_CLASSES = 'Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'

$es = Get-Process ES-DE -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $es) { exit 0 }

function Foreground {
  $h = [LumaGame]::GetForegroundWindow()
  $procId = 0
  [void][LumaGame]::GetWindowThreadProcessId($h, [ref]$procId)
  $name = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
  [pscustomobject]@{ Handle = $h; Pid = $procId; Name = $name; Class = [LumaGame]::ClassOf($h) }
}

function EsWindow {
  $p = Get-Process -Id $es.Id -ErrorAction SilentlyContinue
  if ($p) { $p.MainWindowHandle } else { [IntPtr]::Zero }
}

# 1. Wait (up to 3 minutes: some launchers are slow) for the game to hold
#    the foreground for 3 seconds in a row, then minimize ES-DE.
$deadline = (Get-Date).AddMinutes(3)
$steady = 0
$game = $null
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process -Id $es.Id -ErrorAction SilentlyContinue)) { exit 0 }
  $fg = Foreground
  if ($fg.Name -and $NOT_GAME -notcontains $fg.Name -and $DESKTOP_CLASSES -notcontains $fg.Class) {
    if ($game -and $game.Pid -eq $fg.Pid) { $steady++ } else { $game = $fg; $steady = 1 }
  }
  else { $steady = 0; $game = $null }
  if ($steady -ge 3) { break }
  Start-Sleep -Seconds 1
}
if ($steady -lt 3) { Log "no game took the foreground; leaving ES-DE as it is"; exit 0 }

$h = EsWindow
if ($h -eq [IntPtr]::Zero) { exit 0 }
[LumaGame]::Minimize($h)
Log "minimized ES-DE behind $($game.Name)"

# 2. Until ES-DE is back in front: if the desktop is all that's left (the
#    game closed) for 2 seconds, restore ES-DE.
$onDesktop = 0
while (Get-Process -Id $es.Id -ErrorAction SilentlyContinue) {
  $h = EsWindow
  $fg = Foreground
  if ($h -ne [IntPtr]::Zero -and $fg.Handle -eq $h -and -not [LumaGame]::IsIconic($h)) {
    Log "ES-DE is back in front (Home button or game exit); done"
    exit 0
  }
  if ($fg.Handle -eq [IntPtr]::Zero -or $DESKTOP_CLASSES -contains $fg.Class) { $onDesktop++ } else { $onDesktop = 0 }
  if ($onDesktop -ge 2 -and $h -ne [IntPtr]::Zero) {
    [LumaGame]::Restore($h)
    Log "game closed; restored ES-DE"
    exit 0
  }
  Start-Sleep -Seconds 1
}
