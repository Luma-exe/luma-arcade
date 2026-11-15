import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canSelfUpdate } from "./selfUpdate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// remote/ -> dist -> version.json sits next to main.js, written at build
// time by scripts/copy-assets.mjs.
const VERSION_FILE = path.join(__dirname, "..", "version.json");
// remote/ -> dist (or src) -> server/package.json: the version when running
// from source, or from a build that has no version.json.
const PACKAGE_FILE = path.join(__dirname, "..", "..", "package.json");

const REPO = "Luma-exe/luma-arcade";
const RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
/** GitHub's answer is kept this long (its anonymous limit is 60 calls an hour per address). */
const CACHE_MS = 60 * 60_000;
/** A failed check (offline, rate limited) is remembered this long, so a down network isn't retried on every page load. */
const ERROR_CACHE_MS = 5 * 60_000;

interface LocalVersion {
  commit: string;
  builtAt: string;
  version: string;
}

function readJson(file: string): Record<string, unknown> {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readLocalVersion(): LocalVersion {
  const built = readJson(VERSION_FILE);
  const version = String(built.version ?? readJson(PACKAGE_FILE).version ?? "0.0.0");
  return {
    commit: typeof built.commit === "string" ? built.commit : "unknown",
    builtAt: typeof built.builtAt === "string" ? built.builtAt : "",
    version,
  };
}

/** "v1.4.0" / "1.4.0-beta.1" as [major, minor, patch, prerelease], or null if it isn't a version. */
function parseVersion(text: string): [number, number, number, string] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ""] : null;
}

/** Semver order: negative when a is older than b, 0 when equal, positive when newer.
 * A prerelease (1.4.0-beta.1) is older than its release (1.4.0). Not a version: null. */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  if (x[3] === y[3]) return 0;
  if (!x[3]) return 1;
  if (!y[3]) return -1;
  const px = x[3].split(".");
  const py = y[3].split(".");
  for (let i = 0; i < Math.max(px.length, py.length); i++) {
    if (px[i] === undefined) return -1;
    if (py[i] === undefined) return 1;
    const nx = /^\d+$/.test(px[i]);
    const ny = /^\d+$/.test(py[i]);
    if (nx && ny) {
      if (Number(px[i]) !== Number(py[i])) return Number(px[i]) - Number(py[i]);
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (px[i] !== py[i]) {
      return px[i] < py[i] ? -1 : 1;
    }
  }
  return 0;
}

export interface UpdateStatus {
  /** Git commit this build was made from ("unknown" if it wasn't built from a checkout). */
  localCommit: string;
  builtAt: string;
  /** This build's version (server/package.json). */
  localVersion: string;
  /** The newest published release's version (no "v"), or null if there is none or it couldn't be reached. */
  latestVersion: string | null;
  /** Kept for older screens: the newest release's tag. */
  latestCommit: string | null;
  updateAvailable: boolean;
  /** Can "Apply update" work here: a git checkout is configured to build from. */
  canApply: boolean;
  /** The release's page on GitHub, where the installer is. */
  downloadUrl: string | null;
  compareUrl: string | null;
  error?: string;
}

interface Release {
  tag: string;
  url: string;
}

/** What GitHub last said: a release, or null for "no releases yet". */
let cached: { at: number; release: Release | null } | null = null;
/** The last failure, kept for ERROR_CACHE_MS. */
let cachedError: { at: number; error: Error } | null = null;

export function resetUpdateCache(): void {
  cached = null;
  cachedError = null;
}

/** The newest published release (drafts and prereleases don't count), cached for an hour (a failure for five minutes). */
async function latestRelease(now: number): Promise<Release | null> {
  if (cached && now - cached.at < CACHE_MS) return cached.release;
  if (cachedError && now - cachedError.at < ERROR_CACHE_MS) throw cachedError.error;
  let res: Response;
  try {
    res = await fetch(RELEASE_URL, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "LumaArcade" },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    cachedError = { at: now, error: err as Error };
    throw err;
  }
  let release: Release | null = null;
  if (res.status === 404) {
    // No releases published yet: nothing to update to, and not an error.
  } else if (!res.ok) {
    cachedError = { at: now, error: new Error(`GitHub API returned ${res.status}`) };
    throw cachedError.error;
  } else {
    const data = (await res.json()) as { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean };
    if (data.tag_name && !data.draft && !data.prerelease && parseVersion(data.tag_name)) {
      release = { tag: data.tag_name, url: data.html_url || `https://github.com/${REPO}/releases/latest` };
    }
  }
  cached = { at: now, release };
  cachedError = null;
  return release;
}

export async function checkForUpdate(now = Date.now()): Promise<UpdateStatus> {
  const local = readLocalVersion();
  const base = {
    localCommit: local.commit,
    builtAt: local.builtAt,
    localVersion: local.version,
    canApply: canSelfUpdate().ok,
  };
  try {
    const release = await latestRelease(now);
    if (!release) {
      return { ...base, latestVersion: null, latestCommit: null, updateAvailable: false, downloadUrl: null, compareUrl: null };
    }
    const latestVersion = release.tag.replace(/^v/i, "");
    return {
      ...base,
      latestVersion,
      latestCommit: release.tag,
      updateAvailable: (compareVersions(latestVersion, local.version) ?? 0) > 0,
      downloadUrl: release.url,
      compareUrl: `https://github.com/${REPO}/compare/v${local.version}...${release.tag}`,
    };
  } catch (err) {
    return {
      ...base,
      latestVersion: null,
      latestCommit: null,
      updateAvailable: false,
      downloadUrl: null,
      compareUrl: null,
      error: (err as Error).message,
    };
  }
}
