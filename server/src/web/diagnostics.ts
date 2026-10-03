import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readData } from "../remote/moonlightData.js";
import type { HealthCheck } from "./routes/health.js";

// "Copy diagnostics" on the Host health screen: one block of text to paste
// into a GitHub issue - versions, this PC, every Host health check and the
// recent errors - with names and addresses taken out, so it's safe to post.

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- recent errors (warnings and errors from LumaArcade's log, and error
// lines from the programs it runs)

const MAX_PROBLEMS = 40;
const problems: { at: number; source: string; text: string }[] = [];

export function recordProblem(source: string, text: string, now = Date.now()): void {
  const line = text.trim().slice(0, 400);
  if (!line) return;
  problems.push({ at: now, source, text: line });
  if (problems.length > MAX_PROBLEMS) problems.splice(0, problems.length - MAX_PROBLEMS);
}

export function recentProblems() {
  return [...problems];
}

export function clearProblems(): void {
  problems.length = 0;
}

/** For the Fastify logger (pino's hooks.logMethod): keeps warnings and errors. */
export function problemLogHook(this: unknown, args: unknown[], method: (...a: unknown[]) => void, level: number): void {
  if (level >= 40) {
    const parts = args.map((a) => {
      if (typeof a === "string") return a;
      const o = a as { err?: { message?: string }; msg?: string; message?: string } | null;
      return o?.err?.message ?? o?.message ?? o?.msg ?? "";
    });
    recordProblem("LumaArcade", parts.filter(Boolean).join(" - "));
  }
  method.apply(this, args);
}

/** A program's output line that reads like a failure. */
export function looksLikeError(line: string): boolean {
  return /\b(error|fatal|panic(ked)?|failed|exception)\b/i.test(line);
}

// --- keeping it safe to post

/** Takes out what identifies this PC or its people: IP addresses (not
 * localhost), the PC's name, Windows and Luma Arcade account names, and anything
 * that looks like a token or an email. */
export function redact(text: string, names: string[] = identifyingNames()): string {
  let out = text
    .replace(/\b(?!127\.0\.0\.1\b)(\d{1,3}\.){3}\d{1,3}\b/g, "<ip>")
    .replace(/\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi, "<ip>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "<token>");
  for (const name of names) {
    if (name.length < 3) continue;
    // Whole words only: a player called Ben leaves "Benchmark" alone.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<!\\w)${escaped}(?!\\w)`, "gi"), "<name>");
  }
  return out;
}

function identifyingNames(): string[] {
  const names = [os.hostname(), process.env.COMPUTERNAME, process.env.USERNAME];
  try {
    names.push(os.userInfo().username);
  } catch {}
  // Everyone with an account here (players' names show up in some checks).
  try {
    for (const u of Object.values(readData().users ?? {})) names.push(u.name);
  } catch {}
  return [...new Set(names.filter((n): n is string => !!n))];
}

// --- the report

async function powershell(command: string): Promise<string> {
  try {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-Command", command], { windowsHide: true, timeout: 10_000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

function lumaVersion(): string {
  try {
    return (JSON.parse(readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf-8")) as { version?: string }).version ?? "?";
  } catch {
    return "?";
  }
}

export interface PcFacts {
  windows: string;
  cpu: string;
  ramGb: number;
  graphics: string[];
  sunshine: string;
}

async function pcFacts(): Promise<PcFacts> {
  const [windows, graphics, sunshine] = await Promise.all([
    powershell(
      "$o = Get-CimInstance Win32_OperatingSystem; $d = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').DisplayVersion; \"$($o.Caption) $d (build $($o.BuildNumber))\""
    ),
    powershell("Get-CimInstance Win32_VideoController | ForEach-Object { \"$($_.Name) (driver $($_.DriverVersion))\" }"),
    powershell("(Get-Item 'C:\\Program Files\\Sunshine\\sunshine.exe' -ErrorAction SilentlyContinue).VersionInfo.ProductVersion"),
  ]);
  return {
    windows: windows || `${os.type()} ${os.release()}`,
    cpu: os.cpus()[0]?.model?.trim() ?? "?",
    ramGb: Math.round(os.totalmem() / 1024 ** 3),
    graphics: graphics ? graphics.split(/\r?\n/).map((g) => g.trim()).filter(Boolean) : [],
    sunshine: sunshine || "not found",
  };
}

const MARK: Record<HealthCheck["status"], string> = { ok: "✅", warn: "⚠️", error: "❌" };

export function formatReport(
  info: { version: string; commit: string; node: string; uptimeMin: number; pc: PcFacts; checks: HealthCheck[]; problems: ReturnType<typeof recentProblems> },
  now = Date.now()
): string {
  const lines = [
    "### Luma Arcade diagnostics",
    "",
    `- **Luma Arcade** ${info.version} (${info.commit.slice(0, 7)}), Node ${info.node}, running ${info.uptimeMin} min`,
    `- **Windows** ${info.pc.windows}`,
    `- **Processor** ${info.pc.cpu}, ${info.pc.ramGb} GB RAM`,
    `- **Graphics** ${info.pc.graphics.join("; ") || "none found"}`,
    `- **Sunshine** ${info.pc.sunshine}`,
    "",
    "**Host health**",
    "",
    ...info.checks.map((c) => `- ${MARK[c.status]} ${c.label}: ${c.detail}`),
    "",
    `**Recent errors** (${info.problems.length})`,
    "",
  ];
  if (!info.problems.length) lines.push("None since Luma Arcade started.");
  else {
    lines.push("```");
    for (const p of info.problems) lines.push(`${Math.round((now - p.at) / 60_000)} min ago [${p.source}] ${p.text}`);
    lines.push("```");
  }
  return lines.join("\n");
}

export async function diagnosticsReport(checks: () => Promise<HealthCheck[]>): Promise<string> {
  const [pc, healthChecks] = await Promise.all([pcFacts(), checks().catch((err: Error) => [{ id: "x", label: "Host health", status: "error" as const, detail: `couldn't run: ${err.message}` }])]);
  // Only what can hold addresses and names is cleaned: hardware and
  // versions can't, and driver versions look like IP addresses.
  const names = identifyingNames();
  return formatReport({
    version: lumaVersion(),
    commit: localCommit(),
    node: process.versions.node,
    uptimeMin: Math.round(process.uptime() / 60),
    pc,
    checks: healthChecks.map((c) => ({ ...c, label: redact(c.label, names), detail: redact(c.detail, names) })),
    problems: recentProblems().map((p) => ({ ...p, text: redact(p.text, names) })),
  });
}

/** The commit this build came from (scripts/copy-assets.mjs writes dist/version.json). */
function localCommit(): string {
  try {
    return (JSON.parse(readFileSync(path.join(__dirname, "..", "version.json"), "utf-8")) as { commit?: string }).commit ?? "unknown";
  } catch {
    return "unknown";
  }
}
