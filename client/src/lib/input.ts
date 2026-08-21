export interface InputHandle {
  close: () => void;
}

/**
 * Captures pointer-locked mouse + keyboard events over the video element and
 * forwards them to the server over a plain authenticated WebSocket (not the
 * WebRTC data channel — the media PeerConnection is owned by the video
 * producer, not this Node server, so there's no in-process endpoint for a
 * data channel to terminate at without adding a second WebRTC stack).
 */
export function attachInputCapture(
  videoEl: HTMLVideoElement,
  callbacks?: {
    onLockChange?: (locked: boolean) => void;
    onSocketError?: (message: string) => void;
    /** Fires on every raw mousemove while locked, before the movementX/Y ==
     * 0 filter and before the isLocked() gate matters -- lets the UI show
     * directly whether events are even reaching this handler and what
     * movementX/Y actually contain, without needing devtools access on
     * whatever machine is actually driving the mouse. */
    onDebugMouseMove?: (info: { locked: boolean; movementX: number; movementY: number; sent: boolean }) => void;
    onDebugKey?: (info: { locked: boolean; key: string; sent: boolean }) => void;
  }
): InputHandle {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  let ws: WebSocket;
  let closed = false;
  let reconnectTimer: number | undefined;

  // The input socket was observed going down mid-session with close code
  // 1006 (abnormal closure -- a network-level drop, not a clean server
  // close) with no recovery: unlike the video signalling socket, this one
  // never reconnected, so every mouse/keyboard event after that point was
  // silently discarded by the readyState check in send() while everything
  // upstream (pointer lock, the "controlling" status, this module's own
  // event listeners) kept behaving as if nothing was wrong -- looked exactly
  // like "controls stopped working" with zero visible cause. Reconnecting
  // here, the same way connectToFullDesktopStream already does for the
  // signalling socket, is the actual fix.
  function connect() {
    ws = new WebSocket(`${proto}//${location.host}/input`);
    ws.onerror = () => {
      callbacks?.onSocketError?.("Input connection failed to open.");
    };
    ws.onclose = (e) => {
      if (closed) return;
      if (e.code !== 1000) {
        callbacks?.onSocketError?.(`Input connection dropped (code ${e.code}) — reconnecting…`);
      }
      reconnectTimer = window.setTimeout(connect, 1000);
    };
  }
  connect();

  /** Returns whether the event was actually handed to an open socket --
   * distinct from "we decided to try sending it" -- so debug callers can
   * tell a genuinely dead connection apart from a locally-suppressed event. */
  function send(event: Record<string, unknown>): boolean {
    if (ws.readyState !== ws.OPEN) return false;
    ws.send(JSON.stringify(event));
    return true;
  }

  function onClick() {
    // requestPointerLock() can reject (wrong element focus, browser policy,
    // etc.) — surface that instead of silently doing nothing, since there's
    // otherwise no way to tell "control didn't engage" from "engaged but
    // input isn't reaching the host".
    const result = videoEl.requestPointerLock() as unknown;
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        callbacks?.onSocketError?.(
          `Couldn't lock the pointer: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }
  }

  function onLockChange() {
    callbacks?.onLockChange?.(document.pointerLockElement === videoEl);
  }

  function isLocked() {
    return document.pointerLockElement === videoEl;
  }

  function onMouseMove(e: MouseEvent) {
    const locked = isLocked();
    // Under pointer lock the browser doesn't actually move clientX/clientY —
    // it stays fixed and only movementX/movementY report deltas — so this
    // has to be relative motion, not an absolute position.
    const shouldSend = locked && !!(e.movementX || e.movementY);
    const sent = shouldSend && send({ kind: "mousemove", dx: e.movementX, dy: e.movementY });
    callbacks?.onDebugMouseMove?.({ locked, movementX: e.movementX, movementY: e.movementY, sent });
  }

  function onMouseDown(e: MouseEvent) {
    if (!isLocked()) return;
    send({ kind: "mousedown", button: buttonName(e.button) });
  }

  function onMouseUp(e: MouseEvent) {
    if (!isLocked()) return;
    send({ kind: "mouseup", button: buttonName(e.button) });
  }

  function onWheel(e: WheelEvent) {
    if (!isLocked()) return;
    send({ kind: "wheel", deltaY: e.deltaY });
  }

  function onKeyDown(e: KeyboardEvent) {
    const locked = isLocked();
    if (!locked) {
      callbacks?.onDebugKey?.({ locked, key: e.code, sent: false });
      return;
    }
    e.preventDefault();
    const sent = send({ kind: "keydown", key: e.code });
    callbacks?.onDebugKey?.({ locked, key: e.code, sent });
  }

  function onKeyUp(e: KeyboardEvent) {
    if (!isLocked()) return;
    e.preventDefault();
    send({ kind: "keyup", key: e.code });
  }

  videoEl.addEventListener("click", onClick);
  document.addEventListener("pointerlockchange", onLockChange);
  document.addEventListener("pointerlockerror", () =>
    callbacks?.onSocketError?.("Pointer lock was rejected by the browser.")
  );
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mouseup", onMouseUp);
  window.addEventListener("wheel", onWheel);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  // requestAnimationFrame fires at display refresh rate (up to 240Hz+ on
  // high-refresh monitors), which is far more often than any game needs
  // controller updates and floods the single /input socket enough to starve
  // mouse/keyboard messages behind a growing backlog. Gate sends to ~60Hz.
  // Windows' XInput layer also always reports all 4 controller slots as
  // present even with nothing plugged in — Chrome mirrors that as non-null
  // Gamepad objects, so `connected` (not just non-null) has to gate sending,
  // or 3 phantom controllers get streamed at full rate for no reason.
  const GAMEPAD_SEND_INTERVAL_MS = 1000 / 60;
  let gamepadLoopHandle: number | undefined;
  let lastGamepadSend = 0;
  function pollGamepads(now: number) {
    if (now - lastGamepadSend >= GAMEPAD_SEND_INTERVAL_MS) {
      lastGamepadSend = now;
      for (const gp of navigator.getGamepads()) {
        if (!gp || !gp.connected) continue;
        send({
          kind: "gamepad",
          index: gp.index,
          buttons: gp.buttons.map((b) => b.value),
          axes: gp.axes.slice(0, 4),
        });
      }
    }
    gamepadLoopHandle = requestAnimationFrame(pollGamepads);
  }
  gamepadLoopHandle = requestAnimationFrame(pollGamepads);

  return {
    close: () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      videoEl.removeEventListener("click", onClick);
      document.removeEventListener("pointerlockchange", onLockChange);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      if (gamepadLoopHandle) cancelAnimationFrame(gamepadLoopHandle);
      if (document.pointerLockElement === videoEl) document.exitPointerLock();
      ws.close(1000);
    },
  };
}

function buttonName(button: number): "left" | "right" | "middle" {
  if (button === 2) return "right";
  if (button === 1) return "middle";
  return "left";
}
