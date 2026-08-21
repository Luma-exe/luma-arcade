import { keyboard, mouse, Point, Button, Key } from "@nut-tree-fork/nut-js";
import { execFileSync } from "node:child_process";
import { getSetting } from "../config/settings.js";
import { applyGamepadState, type GamepadState } from "./gamepad.js";

keyboard.config.autoDelayMs = 0;
mouse.config.autoDelayMs = 0;

export type InputEvent =
  | { kind: "mousemove"; dx: number; dy: number } // relative deltas (pointer-locked movementX/Y)
  | { kind: "mousedown"; button: "left" | "right" | "middle" }
  | { kind: "mouseup"; button: "left" | "right" | "middle" }
  | { kind: "wheel"; deltaY: number }
  | { kind: "keydown"; key: string }
  | { kind: "keyup"; key: string }
  | ({ kind: "gamepad" } & GamepadState);

const BUTTON_MAP: Record<string, Button> = {
  left: Button.LEFT,
  right: Button.RIGHT,
  middle: Button.MIDDLE,
};

// Minimal browser KeyboardEvent.code -> nut-js Key mapping. Extend as needed;
// unmapped codes are ignored rather than throwing, so a stray key never
// crashes the input pipeline.
const KEY_MAP: Record<string, Key> = {
  KeyA: Key.A, KeyB: Key.B, KeyC: Key.C, KeyD: Key.D, KeyE: Key.E, KeyF: Key.F,
  KeyG: Key.G, KeyH: Key.H, KeyI: Key.I, KeyJ: Key.J, KeyK: Key.K, KeyL: Key.L,
  KeyM: Key.M, KeyN: Key.N, KeyO: Key.O, KeyP: Key.P, KeyQ: Key.Q, KeyR: Key.R,
  KeyS: Key.S, KeyT: Key.T, KeyU: Key.U, KeyV: Key.V, KeyW: Key.W, KeyX: Key.X,
  KeyY: Key.Y, KeyZ: Key.Z,
  Digit0: Key.Num0, Digit1: Key.Num1, Digit2: Key.Num2, Digit3: Key.Num3,
  Digit4: Key.Num4, Digit5: Key.Num5, Digit6: Key.Num6, Digit7: Key.Num7,
  Digit8: Key.Num8, Digit9: Key.Num9,
  Space: Key.Space, Enter: Key.Enter, Escape: Key.Escape, Backspace: Key.Backspace,
  Tab: Key.Tab, ShiftLeft: Key.LeftShift, ShiftRight: Key.RightShift,
  ControlLeft: Key.LeftControl, ControlRight: Key.RightControl,
  AltLeft: Key.LeftAlt, AltRight: Key.RightAlt,
  ArrowUp: Key.Up, ArrowDown: Key.Down, ArrowLeft: Key.Left, ArrowRight: Key.Right,
};

interface VirtualScreenBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Multi-monitor Windows setups place secondary displays at negative or
// large-positive coordinates relative to the primary monitor (e.g. a
// display to the left of primary starts at x=-1920) — the origin isn't
// (0,0) and the extent isn't the primary monitor's own resolution. Clamping
// mousemove deltas to a hardcoded 0..1920 box (or to whatever monitor the
// browser tab reporting window.screen.width happens to sit on, which is a
// different — and often wrong — display than whatever's actually being
// captured/streamed) silently makes the cursor unreachable on any other
// monitor, which looks exactly like "the mouse doesn't move at all" when
// the streamed window happens to live there. Query the OS for the true
// virtual desktop bounds instead of trusting client-supplied dimensions.
function queryVirtualScreenBounds(): VirtualScreenBounds {
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; " +
          "$vs=[System.Windows.Forms.SystemInformation]::VirtualScreen; " +
          '"$($vs.X),$($vs.Y),$($vs.Width),$($vs.Height)"',
      ],
      { encoding: "utf-8" }
    ).trim();
    const [x, y, width, height] = out.split(",").map(Number);
    if ([x, y, width, height].some((n) => !Number.isFinite(n))) {
      throw new Error(`unparseable output: "${out}"`);
    }
    return { x, y, width, height };
  } catch (err) {
    console.warn(
      "[input] failed to query virtual screen bounds, defaulting to a single 1920x1080 monitor at the origin:",
      (err as Error).message
    );
    return { x: 0, y: 0, width: 1920, height: 1080 };
  }
}

let virtualScreen = queryVirtualScreenBounds();

/** Called once per stream start — re-queries display topology in case
 * monitors were plugged/unplugged/rearranged since the server booted. The
 * width/height arguments are accepted for API stability but unused: they
 * describe the browser tab's own monitor, not the captured target's. */
export function setScreenSize(_width: number, _height: number): void {
  virtualScreen = queryVirtualScreenBounds();
}

export async function applyInputEvent(event: InputEvent): Promise<void> {
  switch (event.kind) {
    case "mousemove": {
      const sensitivity = getSetting("mouseSensitivity");
      const current = await mouse.getPosition();
      const x = Math.min(
        virtualScreen.x + virtualScreen.width - 1,
        Math.max(virtualScreen.x, current.x + event.dx * sensitivity)
      );
      const y = Math.min(
        virtualScreen.y + virtualScreen.height - 1,
        Math.max(virtualScreen.y, current.y + event.dy * sensitivity)
      );
      await mouse.setPosition(new Point(x, y));
      break;
    }
    case "mousedown":
      await mouse.pressButton(BUTTON_MAP[event.button]);
      break;
    case "mouseup":
      await mouse.releaseButton(BUTTON_MAP[event.button]);
      break;
    case "wheel":
      if (event.deltaY !== 0) {
        const deltaY = getSetting("invertScroll") ? -event.deltaY : event.deltaY;
        await mouse.scrollDown(Math.round(deltaY));
      }
      break;
    case "keydown": {
      const key = KEY_MAP[event.key];
      if (key !== undefined) await keyboard.pressKey(key);
      break;
    }
    case "keyup": {
      const key = KEY_MAP[event.key];
      if (key !== undefined) await keyboard.releaseKey(key);
      break;
    }
    case "gamepad":
      applyGamepadState(event);
      break;
  }
}
