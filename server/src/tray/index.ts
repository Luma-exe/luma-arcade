import SysTrayPkg from "systray2";
import { exec } from "node:child_process";
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

export function startTray(opts: {
  portalUrl: string;
  onQuit: () => void;
}): InstanceType<typeof SysTray> {
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

  const tray = new SysTray({
    menu: {
      icon: ICON_PATH,
      title: "LumaArcade",
      tooltip: "LumaArcade",
      items: [openItem, settingsItem, quitItem],
    },
    debug: false,
    copyDir: true,
  });

  tray.onClick((action) => {
    (action.item as typeof openItem | typeof settingsItem | typeof quitItem).click?.();
  });

  return tray;
}
