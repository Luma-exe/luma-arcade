// Electron host for the WebRTC video producer. Plain Chromium's
// `--auto-select-desktop-capture-source` flag (matching a source by its
// picker label, e.g. "Screen 1") turned out to be unreliable in testing —
// nondeterministic across runs, and its match failure mode is a silently
// hung getDisplayMedia() promise waiting on a picker dialog nobody can see
// or click (the window is deliberately off-screen/minimized). Electron's
// `desktopCapturer` API sidesteps all of that: it enumerates real capture
// sources programmatically, so the exact source is picked by code, not by
// guessing a label string.
const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require("electron");
const path = require("node:path");
const { spawn } = require("node:child_process");

// Window capture (as opposed to full-screen) defaults to a BitBlt-based
// capturer on Windows that reliably fails ("Could not start video source",
// observed in testing) against GPU-composited/DirectX-rendered windows --
// exactly what game/emulator frontends like ES-DE are. WGC (Windows.Graphics
// .Capture) is the modern API that actually handles those correctly; this
// flag opts Chromium's window capturer into using it.
app.commandLine.appendSwitch("enable-features", "WebRtcAllowWgcWindowCapturer,WebRtcAllowWgcScreenCapturer");

// Temporary: get the real HRESULT/reasoning behind "Duplication failed"
// instead of Chromium's generic wrapper message, and confirm which
// capturer (WGC vs the older DXGI-duplication-based one) is actually
// selected for screen sources despite the feature flags above.
app.commandLine.appendSwitch("enable-logging", "stderr");
app.commandLine.appendSwitch("log-level", "0");
app.commandLine.appendSwitch(
  "vmodule",
  "screen_capturer_win_directx=3,wgc_capturer_win=3,dxgi_duplicator_controller=3,dxgi_output_duplicator=3,desktop_capturer=3"
);

// Belt-and-suspenders alongside webPreferences.backgroundThrottling: false
// below -- these process-wide switches stop Chromium from deprioritizing
// timers/rendering for windows/tabs it considers backgrounded, which this
// window always is (it's permanently hidden by design).
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

// Newer Electron denies media-device permission requests (including the
// getUserMedia call our producer.html makes for desktop capture) unless the
// main process explicitly grants them -- without this, capture fails before
// it even gets to picking a source.
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    // We already picked the exact source via desktopCapturer in main() and
    // pass its id through additionalArguments -- this handler only exists
    // because some Electron versions require *a* handler to be registered
    // at all for getDisplayMedia-family requests to be allowed through.
    callback({});
  });
});

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(app.isPackaged ? 1 : 2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const [key, inlineValue] = argv[i].slice(2).split("=");
      args[key] = inlineValue ?? argv[i + 1];
      if (inlineValue === undefined) i++;
    }
  }
  return args;
}

// The server's active virtual display driver doesn't implement DXGI Desktop
// Duplication correctly (confirmed via setupapi/vmodule logging: duplication
// fails on every GPU adapter, continuously, independent of RDP state), and
// Chromium's screen capturer commits to the DXGI-based path with no reachable
// flag to force its GDI fallback instead. So for screen/monitor capture we
// bypass Chromium's capturer entirely: a persistent PowerShell child process
// grabs frames via plain GDI BitBlt (gdi-capture.ps1) and streams them to the
// renderer over stdout, framed as [4-byte little-endian length][JPEG bytes].
let gdiRelayProcess;
let gdiRelayWindow;
let gdiRelayBuffer = Buffer.alloc(0);

function startGdiRelay(win, monitorIndex) {
  if (gdiRelayProcess) return;
  gdiRelayWindow = win;
  const scriptPath = path.join(__dirname, "gdi-capture.ps1");
  gdiRelayProcess = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-MonitorIndex", String(monitorIndex ?? 0), "-Fps", "20", "-Quality", "70"],
    { windowsHide: true }
  );

  gdiRelayProcess.stdout.on("data", (chunk) => {
    gdiRelayBuffer = Buffer.concat([gdiRelayBuffer, chunk]);
    while (gdiRelayBuffer.length >= 4) {
      const frameLen = gdiRelayBuffer.readInt32LE(0);
      if (gdiRelayBuffer.length < 4 + frameLen) break;
      const frame = gdiRelayBuffer.subarray(4, 4 + frameLen);
      gdiRelayWindow?.webContents.send("gdi-frame", frame);
      gdiRelayBuffer = gdiRelayBuffer.subarray(4 + frameLen);
    }
  });
  gdiRelayProcess.stderr.on("data", (chunk) => console.error(`[gdi-capture] ${chunk.toString().trim()}`));
  gdiRelayProcess.on("exit", (code) => {
    console.error(`[gdi-capture] exited with code ${code}`);
    gdiRelayProcess = undefined;
  });
}

ipcMain.handle("start-gdi-relay", (event, { monitorIndex }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  startGdiRelay(win, monitorIndex);
});

async function pickSource(mode, windowTitle, monitorIndex) {
  const types = mode === "window" ? ["window"] : ["screen"];
  const sources = await desktopCapturer.getSources({ types, thumbnailSize: { width: 0, height: 0 } });

  if (mode === "window" && windowTitle) {
    const match = sources.find((s) => s.name.includes(windowTitle));
    if (match) return match;
    console.error(`[producer] no window source matched title "${windowTitle}", falling back to first available`);
    return sources[0];
  }

  if (mode === "desktop" && monitorIndex !== undefined) {
    const index = Number(monitorIndex);
    if (Number.isInteger(index) && sources[index]) return sources[index];
    console.error(`[producer] no screen source at index ${monitorIndex}, falling back to primary`);
  }

  return sources[0];
}

async function main() {
  const args = parseArgs();
  const port = args.port ?? "7777";
  const mode = args.mode === "window" ? "window" : "desktop";
  const windowTitle = args["window-title"];
  const monitorIndex = args["monitor-index"];

  const configRes = await fetch(`http://127.0.0.1:${port}/internal/producer-config`);
  const config = await configRes.json();

  // Desktop/monitor capture always goes through the GDI relay (see
  // startGdiRelay above) -- Chromium's own screen capturer can't work on
  // this server's display driver. Window capture (e.g. ES-DE) still tries
  // Chromium's WGC-backed window capturer first since that's a different
  // code path that hasn't been shown to have the same problem, falling back
  // to the GDI relay (of the primary screen) if it fails.
  const source = mode === "window" ? await pickSource("window", windowTitle, undefined) : undefined;
  if (mode === "window" && !source) {
    console.error("[producer] no capture source available at all");
    app.quit();
    return;
  }

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      // Chromium throttles rendering/capture for hidden/backgrounded
      // windows to save resources -- this window is *always* hidden by
      // design (show: false), so without this the desktop capture stream
      // was observed to deliver exactly one frame and then freeze: the
      // WebRTC connection stayed healthy (input kept working, stats kept
      // updating) but the video track itself stopped producing new frames.
      backgroundThrottling: false,
      additionalArguments: [
        `--luma-config=${JSON.stringify({
          ...config,
          sourceId: source?.id,
          useGdiRelay: mode === "desktop",
          monitorIndex: Number(monitorIndex ?? 0) || 0,
        })}`,
      ],
    },
  });

  if (mode === "desktop") startGdiRelay(win, Number(monitorIndex ?? 0) || 0);

  await win.loadFile(path.join(__dirname, "producer.html"));
}

ipcMain.on("producer-status", (_event, status) => {
  console.log(`[producer] ${status}`);
});

app.whenReady().then(main);

app.on("window-all-closed", () => app.quit());
