import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// remote/ -> dist -> version.json sits next to main.js, written at build
// time by scripts/copy-assets.mjs.
const VERSION_FILE = path.join(__dirname, "..", "version.json");

const REPO = "Luma-exe/luma-arcade";
const BRANCH = "main";

interface LocalVersion {
  commit: string;
  builtAt: string;
}

function readLocalVersion(): LocalVersion {
  if (!existsSync(VERSION_FILE)) return { commit: "unknown", builtAt: "" };
  try {
    return JSON.parse(readFileSync(VERSION_FILE, "utf-8")) as LocalVersion;
  } catch {
    return { commit: "unknown", builtAt: "" };
  }
}

export interface UpdateStatus {
  localCommit: string;
  builtAt: string;
  latestCommit: string | null;
  updateAvailable: boolean;
  compareUrl: string | null;
  error?: string;
}

export async function checkForUpdate(): Promise<UpdateStatus> {
  const local = readLocalVersion();
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "LumaArcade" },
    });
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
    const data = (await res.json()) as { sha: string };
    const latestCommit = data.sha;
    return {
      localCommit: local.commit,
      builtAt: local.builtAt,
      latestCommit,
      updateAvailable: local.commit !== "unknown" && local.commit !== latestCommit,
      compareUrl:
        local.commit !== "unknown"
          ? `https://github.com/${REPO}/compare/${local.commit}...${latestCommit}`
          : `https://github.com/${REPO}`,
    };
  } catch (err) {
    return {
      localCommit: local.commit,
      builtAt: local.builtAt,
      latestCommit: null,
      updateAvailable: false,
      compareUrl: null,
      error: (err as Error).message,
    };
  }
}
