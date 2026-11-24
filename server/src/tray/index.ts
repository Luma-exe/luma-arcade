import SysTrayPkg from "systray2";
import { exec, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// systray2's CJS build doesn't set the __esModule interop flag, so a plain
// default import ends up wrapping the whole `{ default: SysTray }` object
// instead of unwrapping it — unwrap it manually.
const SysTray = ((SysTrayPkg as any).default ?? SysTrayPkg) as typeof SysTrayPkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/tray -> dist -> server -> server/assets (installer stages "assets"
// as a sibling of "dist", see installer/build.mjs)
const ICON_PATH = path.join(__dirname, "..", "..", "assets", "tray-icon.ico");
// The same star with an orange dot: updates are ready.
const UPDATE_ICON_PATH = path.join(__dirname, "..", "..", "assets", "tray-icon-update.ico");

const UPDATES_TITLE = "Check for updates…";

/** Edge, for opening a page as its own small window (no tabs or address bar). */
function findEdge(): string | null {
  for (const base of [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA]) {
    if (!base) continue;
    const exe = path.join(base, "Microsoft", "Edge", "Application", "msedge.exe");
    if (existsSync(exe)) return exe;
  }
  return null;
}

/** Opens url in a window of its own; a browser tab when Edge isn't there. */
export function openAppWindow(url: string, width = 1000, height = 880): void {
  const edge = findEdge();
  if (edge) {
    const child = spawn(edge, [`--app=${url}`, `--window-size=${width},${height}`], { detached: true, stdio: "ignore" });
    child.on("error", () => exec(`start "" "${url}"`));
    child.unref();
    return;
  }
  exec(`start "" "${url}"`);
}

export interface Tray {
  /** Shows how many updates are ready: a dot on the icon and a count in the menu. */
  setUpdateCount(count: number): void;
}

export function startTray(opts: {
  portalUrl: string;
  /** The Updates window's address (with its key). */
  updatesUrl: string;
  onQuit: () => void;
}): Tray {
  const openItem = {
    title: "Open Portal",
    tooltip: "Open the LumaArcade portal in your browser",
    checked: false,
    enabled: true,
    click: () => exec(`start ${opts.portalUrl}`),
  };

  const settingsItem = {
    title: "Settings",
    tooltip: "Open LumaArcade settings — streaming, controls, network, and more",
    checked: false,
    enabled: true,
    click: () => exec(`start ${opts.portalUrl}/?view=settings`),
  };

  const updatesItem = {
    title: UPDATES_TITLE,
    tooltip: "Check Luma Arcade, ES-DE, the emulators and the streaming parts for updates",
    checked: false,
    enabled: true,
    click: () => openAppWindow(opts.updatesUrl),
  };

  const quitItem = {
    title: "Quit",
    tooltip: "Stop LumaArcade",
    checked: false,
    enabled: true,
    click: () => {
      tray.kill(false);
      opts.onQuit();
    },
  };

  const menu = {
    icon: ICON_PATH,
    title: "LumaArcade",
    tooltip: "LumaArcade",
    items: [openItem, settingsItem, updatesItem, quitItem],
  };
  const tray = new SysTray({ menu, debug: false, copyDir: true });

  tray.onClick((action) => {
    (action.item as typeof openItem).click?.();
  });

  let shown = 0;
  return {
    setUpdateCount(count: number) {
      if (count === shown) return;
      shown = count;
      updatesItem.title = count ? `${UPDATES_TITLE} (${count} ready)` : UPDATES_TITLE;
      menu.icon = count && existsSync(UPDATE_ICON_PATH) ? UPDATE_ICON_PATH : ICON_PATH;
      menu.tooltip = count ? `LumaArcade · ${count} update${count > 1 ? "s" : ""} ready` : "LumaArcade";
      tray
        .ready()
        .then(() => tray.sendAction({ type: "update-menu", menu } as never))
        .catch(() => {});
    },
  };
}
