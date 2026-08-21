import { execFile } from "node:child_process";

/**
 * Windows suspends real GPU compositing for an RDP session once its client
 * disconnects — there's nothing to render to, so the session's desktop stops
 * updating. Screen-capture APIs (which is what the streaming pipeline relies
 * on) then return blank or stale frames until someone reconnects and
 * interacts, which looked from the outside like the capture "freezing" —
 * exactly the headless-server-with-no-monitor scenario LumaArcade needs to
 * work in.
 *
 * The standard fix (used by cloud-gaming/streaming setups generally) is the
 * `tscon /dest:console` trick: it re-labels the current session as "console"
 * — the type Windows never suspends compositing for — so rendering, and
 * therefore capture, keeps working correctly regardless of whether an RDP
 * client is currently attached. It's best-effort and non-fatal: on a normal
 * desktop with a real monitor this is a no-op the app doesn't need, and it
 * silently no-ops here too if the process isn't running elevated enough to
 * remap a session (typical unless the app was launched as an admin/service).
 */
export function promoteToConsoleSessionIfNeeded(): void {
  if (process.platform !== "win32") return;

  execFile(
    "powershell.exe",
    ["-NoProfile", "-Command", `(Get-Process -Id ${process.pid}).SessionId`],
    (err, stdout) => {
      if (err) return;
      const sessionId = stdout.trim();
      if (!sessionId || sessionId === "0") return; // session 0 = Services, no desktop to promote

      execFile("tscon.exe", [sessionId, "/dest:console"], (tsconErr) => {
        if (tsconErr) {
          // Common and harmless: already console, or not privileged enough.
          console.log(
            `[display] session ${sessionId} not promoted to console (${tsconErr.message.trim()}) — fine if this machine has a real monitor or is already console`
          );
        } else {
          console.log(
            `[display] promoted session ${sessionId} to console — GPU rendering stays active even if this RDP session disconnects`
          );
        }
      });
    }
  );
}
