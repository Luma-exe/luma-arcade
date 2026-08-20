import { keyboard, mouse, Point, Button, Key } from "@nut-tree-fork/nut-js";
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

let screenWidth = 1920;
let screenHeight = 1080;

export function setScreenSize(width: number, height: number): void {
  screenWidth = width;
  screenHeight = height;
}

export async function applyInputEvent(event: InputEvent): Promise<void> {
  switch (event.kind) {
    case "mousemove": {
      const current = await mouse.getPosition();
      const x = Math.min(screenWidth - 1, Math.max(0, current.x + event.dx));
      const y = Math.min(screenHeight - 1, Math.max(0, current.y + event.dy));
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
        await mouse.scrollDown(Math.round(event.deltaY));
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
