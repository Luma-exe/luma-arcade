<#
  ES-DE game-start event script for Switch, Wii and GameCube games (called by
  <ES-DE>\scripts\game-start\00-emulator-window.bat, which passes ES-DE's
  system name and only calls this for those systems).

  Eden (Switch) and Dolphin (Wii, GameCube) remember their window's place and
  size and put it back on the next start (Eden: user\config\window_state.ini,
  Dolphin: Config\Qt.ini). The games PC's screen changes size with every
  player's stream, so after someone played at another size, the next game
  opened off to the side instead of filling the screen, until someone left
  fullscreen and went back in.

  1. Before the emulator starts: forget the saved window place and size (it's
     closed then, so it can't write them back).
  2. In the background, while it runs: when its window is fullscreen (no
     title bar) but doesn't cover the screen, put it over the whole screen -
     the same thing leaving and re-entering fullscreen does.

  The .bat runs this without "start", so ES-DE waits for step 1 (a fraction
  of a second); step 2 relaunches itself hidden and returns at once.
#>
param([string]$System, [string]$Process, [switch]$Watch)

$LOG = 'C:\ProgramData\LumaArcade\home\emulator-window.log'
function Log($m) { try { Add-Content $LOG "$(Get-Date -Format s) $m" } catch {} }

if (-not $Watch) {
  # Emulators and the games account's AppData\Roaming: host.json
  # (installer/scripts/install-host.ps1), else the original gaming PC's.
  $emulators = 'G:\ES-DE\Emulators'
  $roaming = 'C:\Users\Arcade\AppData\Roaming'
  $hostFile = 'C:\ProgramData\LumaArcade\host.json'
  try {
    if (Test-Path $hostFile) {
      $h = Get-Content -Raw $hostFile | ConvertFrom-Json
      if ($h.emulators) { $emulators = $h.emulators }
      if ($h.roaming) { $roaming = $h.roaming }
    }
  } catch {}

  # Which emulator, its settings file, and the [sections] whose geometry= it
  # restores ('' = no sections in the file).
  $emu = switch -Regex ($System) {
    '^switch$' { @{ Process = 'eden'; File = (Join-Path $emulators 'eden\user\config\window_state.ini'); Keys = '^geometry(RenderWindow)?='; Sections = @('General') } }
    '^(wii|gc|gamecube|wiiware)$' { @{ Process = 'Dolphin'; File = (Join-Path $roaming 'Dolphin Emulator\Config\Qt.ini'); Keys = '^geometry='; Sections = @('mainwindow', 'renderwidget') } }
    default { $null }
  }
  if (-not $emu) { exit 0 }

  if ((Test-Path $emu.File) -and -not (Get-Process $emu.Process -ErrorAction SilentlyContinue)) {
    try {
      $lines = @(Get-Content $emu.File)
      $section = 'General'
      $kept = @(foreach ($line in $lines) {
        if ($line -match '^\[(.+)\]$') { $section = $Matches[1] }
        if ($emu.Sections -contains $section -and $line -match $emu.Keys) { continue }
        $line
      })
      if ($kept.Count -ne $lines.Count) {
        Set-Content -Path $emu.File -Value $kept -Encoding ASCII
        Log "$($emu.Process): forgot the saved window size"
      }
    } catch { Log "couldn't change $($emu.File): $($_.Exception.Message)" }
  }

  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$PSCommandPath`"", '-Watch', '-Process', $emu.Process)
  exit 0
}

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class LumaEmuWindow {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO i);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);

  // The process's biggest visible top-level window without a title bar: the
  // fullscreen game (Dolphin can show its game list window as well).
  public static IntPtr FullscreenWindow(uint pid) {
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      RECT r;
      // Tool windows (menus, tooltips) and anything smaller than 640x360
      // (loading popups) aren't the game.
      if (p == pid && IsWindowVisible(h) && !HasTitleBar(h) && (GetWindowLong(h, -20) & 0x80) == 0
          && GetWindowRect(h, out r) && r.Right - r.Left >= 640 && r.Bottom - r.Top >= 360) {
        long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
        if (area > bestArea) { best = h; bestArea = area; }
      }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  // Fullscreen (borderless or exclusive) has no title bar.
  public static bool HasTitleBar(IntPtr h) { return (GetWindowLong(h, -16) & 0x00C00000) == 0x00C00000; }

  public static RECT Screen(IntPtr h) {
    var i = new MONITORINFO(); i.cbSize = Marshal.SizeOf(i);
    GetMonitorInfo(MonitorFromWindow(h, 2), ref i);
    return i.rcMonitor;
  }

  public static void Cover(IntPtr h, RECT s) {
    // Eden's own borderless fullscreen is the screen plus one pixel of height
    // (so Windows doesn't treat it as exclusive fullscreen); do the same for
    // both, Dolphin is just as happy with it.
    SetWindowPos(h, IntPtr.Zero, s.Left, s.Top, s.Right - s.Left, s.Bottom - s.Top + 1, 0x0004 | 0x0010 | 0x0020);
  }
}
"@

# The emulator may take a few seconds to start after ES-DE's event scripts.
$emu = $null
for ($i = 0; $i -lt 60 -and -not $emu; $i++) {
  $emu = Get-Process $Process -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $emu) { Start-Sleep -Seconds 1 }
}
if (-not $emu) { exit 0 }

$fixes = 0
while (-not $emu.HasExited) {
  $h = [LumaEmuWindow]::FullscreenWindow([uint32]$emu.Id)
  if ($h -ne [IntPtr]::Zero -and -not [LumaEmuWindow]::IsIconic($h)) {
    $r = New-Object LumaEmuWindow+RECT
    [void][LumaEmuWindow]::GetWindowRect($h, [ref]$r)
    $s = [LumaEmuWindow]::Screen($h)
    $covers = $r.Left -le $s.Left -and $r.Top -le $s.Top -and $r.Right -ge $s.Right -and $r.Bottom -ge $s.Bottom
    $tooBig = ($r.Right - $r.Left) -gt ($s.Right - $s.Left) + 8 -or ($r.Bottom - $r.Top) -gt ($s.Bottom - $s.Top) + 8
    # A few tries at most: if the emulator keeps moving it back, leave it be.
    if ((-not $covers -or $tooBig) -and $fixes -lt 5) {
      [LumaEmuWindow]::Cover($h, $s)
      $fixes++
      Log ("${Process}: fullscreen window was {0},{1} {2}x{3} on a {4}x{5} screen; made it fill the screen" -f
        $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top), ($s.Right - $s.Left), ($s.Bottom - $s.Top))
    }
  }
  Start-Sleep -Seconds 2
  $emu.Refresh()
}
