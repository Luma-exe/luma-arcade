/**
 * Virtual Xbox 360 controller injection via ViGEmBus, using the `vigemclient`
 * npm package (native binding, confirmed against its actual source: sticks
 * take -1..1, triggers 0..1 — the same ranges the browser Gamepad API uses,
 * so mapping is close to 1:1). Requires the ViGEmBus driver installed on the
 * host; if it's missing (or the optional dependency failed to build on a
 * non-Windows dev machine), every call here becomes a silent no-op rather
 * than crashing the server — gamepad support degrades gracefully.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type X360Controller = any;

let client: any;
let connected = false;
let warned = false;
const controllers = new Map<number, X360Controller>();

function tryConnect(): boolean {
  if (connected) return true;
  try {
    // Optional native dependency — require() lazily so its absence (or a
    // failed native build) never breaks server startup.
    const ViGEmClient = require("vigemclient");
    client = new ViGEmClient();
    const err = client.connect();
    if (err) throw err;
    connected = true;
    return true;
  } catch (err) {
    if (!warned) {
      console.warn(
        "[gamepad] ViGEmBus not available — gamepad passthrough disabled:",
        (err as Error)?.message ?? err
      );
      warned = true;
    }
    return false;
  }
}

function getController(index: number): X360Controller | undefined {
  if (!tryConnect()) return undefined;
  let controller = controllers.get(index);
  if (!controller) {
    controller = client.createX360Controller();
    controller.updateMode = "manual";
    const err = controller.connect();
    if (err) {
      console.warn(`[gamepad] failed to plug in virtual controller ${index}:`, err);
      return undefined;
    }
    controllers.set(index, controller);
  }
  return controller;
}

// Order matches the browser Gamepad API's standard mapping button indices.
const BUTTON_NAMES = [
  "A", "B", "X", "Y",
  "LEFT_SHOULDER", "RIGHT_SHOULDER",
  null, null, // triggers are axes, handled separately (buttons[6]/[7].value)
  "BACK", "START",
  "LEFT_THUMB", "RIGHT_THUMB",
  null, null, null, null, // dpad handled via axes below
  "GUIDE",
] as const;

export interface GamepadState {
  index: number;
  buttons: number[]; // 0..1 per standard Gamepad API button order
  axes: number[]; // [leftX, leftY, rightX, rightY]
}

export function applyGamepadState(state: GamepadState): void {
  const controller = getController(state.index);
  if (!controller) return;

  for (let i = 0; i < BUTTON_NAMES.length; i++) {
    const name = BUTTON_NAMES[i];
    if (!name) continue;
    controller.button[name].setValue((state.buttons[i] ?? 0) > 0.5);
  }

  controller.axis.leftX.setValue(state.axes[0] ?? 0);
  controller.axis.leftY.setValue(-(state.axes[1] ?? 0)); // browser Y is inverted vs XInput
  controller.axis.rightX.setValue(state.axes[2] ?? 0);
  controller.axis.rightY.setValue(-(state.axes[3] ?? 0));
  controller.axis.leftTrigger.setValue(state.buttons[6] ?? 0);
  controller.axis.rightTrigger.setValue(state.buttons[7] ?? 0);
  controller.axis.dpadHorz.setValue((state.buttons[15] ?? 0) - (state.buttons[14] ?? 0));
  controller.axis.dpadVert.setValue((state.buttons[12] ?? 0) - (state.buttons[13] ?? 0));

  controller.update();
}
