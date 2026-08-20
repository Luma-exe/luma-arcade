export interface InputHandle {
  close: () => void;
}

/**
 * Captures pointer-locked mouse + keyboard events over the video element and
 * forwards them to the server over a plain authenticated WebSocket (not the
 * WebRTC data channel — the media PeerConnection is owned by the GStreamer
 * child process, not this Node server, so there's no in-process endpoint for
 * a data channel to terminate at without adding a second WebRTC stack).
 */
export function attachInputCapture(videoEl: HTMLVideoElement): InputHandle {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/input`);

  function send(event: Record<string, unknown>) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  }

  function onClick() {
    videoEl.requestPointerLock();
  }

  function isLocked() {
    return document.pointerLockElement === videoEl;
  }

  function onMouseMove(e: MouseEvent) {
    if (!isLocked()) return;
    // Under pointer lock the browser doesn't actually move clientX/clientY —
    // it stays fixed and only movementX/movementY report deltas — so this
    // has to be relative motion, not an absolute position.
    if (e.movementX || e.movementY) {
      send({ kind: "mousemove", dx: e.movementX, dy: e.movementY });
    }
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
    if (!isLocked()) return;
    e.preventDefault();
    send({ kind: "keydown", key: e.code });
  }

  function onKeyUp(e: KeyboardEvent) {
    if (!isLocked()) return;
    e.preventDefault();
    send({ kind: "keyup", key: e.code });
  }

  videoEl.addEventListener("click", onClick);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mouseup", onMouseUp);
  window.addEventListener("wheel", onWheel);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  let gamepadLoopHandle: number | undefined;
  function pollGamepads() {
    for (const gp of navigator.getGamepads()) {
      if (!gp) continue;
      send({
        kind: "gamepad",
        index: gp.index,
        buttons: gp.buttons.map((b) => b.value),
        axes: gp.axes.slice(0, 4),
      });
    }
    gamepadLoopHandle = requestAnimationFrame(pollGamepads);
  }
  gamepadLoopHandle = requestAnimationFrame(pollGamepads);

  return {
    close: () => {
      videoEl.removeEventListener("click", onClick);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      if (gamepadLoopHandle) cancelAnimationFrame(gamepadLoopHandle);
      if (document.pointerLockElement === videoEl) document.exitPointerLock();
      ws.close();
    },
  };
}

function buttonName(button: number): "left" | "right" | "middle" {
  if (button === 2) return "right";
  if (button === 1) return "middle";
  return "left";
}
