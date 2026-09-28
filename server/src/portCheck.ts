import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// LumaArcade runs as the NSSM service "luma-arcade". PM2 once ran it too, and
// PM2 brings its old copy back from its dump file on its own, which then
// holds the port so the service crash-loops with a bare EADDRINUSE. This
// says who has the port, and what to do about it.

async function stdout(file: string, args: string[]): Promise<string> {
  try {
    return (await run(file, args, { windowsHide: true, timeout: 8000 })).stdout;
  } catch (err) {
    return (err as { stdout?: string }).stdout ?? "";
  }
}

/** The PID listening on this TCP port, if any. */
async function listeningPid(port: number): Promise<number | null> {
  const table = await stdout("netstat.exe", ["-ano", "-p", "tcp"]);
  for (const line of table.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    // Proto  Local Address  Foreign Address  State  PID
    if (cols[0] === "TCP" && cols[3] === "LISTENING" && cols[1].endsWith(`:${port}`)) return Number(cols[4]);
  }
  return null;
}

async function processInfo(pid: number): Promise<{ commandLine: string; parentPid: number } | null> {
  const out = await stdout("powershell.exe", [
    "-NoProfile",
    "-Command",
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { "$($p.ParentProcessId)"; $p.CommandLine }`,
  ]);
  const [parent, ...rest] = out.split(/\r?\n/);
  if (!parent?.trim()) return null;
  return { parentPid: Number(parent.trim()), commandLine: rest.join(" ").trim() };
}

/** A plain-language explanation of who holds `port`, for the log. */
export async function explainPortInUse(port: number): Promise<string> {
  const pid = await listeningPid(port);
  if (!pid) return `Port ${port} is already in use.`;
  const info = await processInfo(pid);
  const parent = info ? await processInfo(info.parentPid) : null;
  const byPm2 = [info?.commandLine, parent?.commandLine].some((c) => !!c && /[\/]pm2[\/]|ProcessContainer/i.test(c));
  if (byPm2) {
    return (
      `Port ${port} is held by a copy of LumaArcade that PM2 started (pid ${pid}). ` +
      `PM2 restores it from its dump file; remove it for good with: pm2 delete luma-arcade luma-arcade-tunnel; pm2 save`
    );
  }
  return `Port ${port} is already in use by pid ${pid}${info?.commandLine ? ` (${info.commandLine})` : ""}. Stop it, or change LumaArcade's port.`;
}
