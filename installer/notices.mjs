// Generates THIRD-PARTY-NOTICES.md from server's production dependency tree.
//
//   node installer/notices.mjs           write THIRD-PARTY-NOTICES.md
//   node installer/notices.mjs --check   exit 1 if the committed file is stale
//
// The dependency set comes from package-lock.json (everything under
// node_modules/ that isn't dev-only), so it's the same on every machine.
// Copyright lines come from LICENSE files in node_modules when installed;
// they're informational and not part of the staleness check, which compares
// a fingerprint of name@version:license for every package.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFile = path.join(repoRoot, "THIRD-PARTY-NOTICES.md");
const FP = /<!-- notices-fingerprint: ([0-9a-f]{64}) -->/;

const lock = JSON.parse(readFileSync(path.join(repoRoot, "package-lock.json"), "utf-8"));
const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
const versions = JSON.parse(readFileSync(path.join(repoRoot, "installer", "scripts", "versions.json"), "utf-8"));

function licenseOf(meta) {
  const l = meta.license;
  if (!l) return "UNKNOWN";
  if (typeof l === "string") return l;
  if (Array.isArray(l)) return l.map((x) => x.type ?? x).join(" OR ");
  return l.type ?? "UNKNOWN";
}

function copyrightOf(dir) {
  if (!existsSync(dir)) return "";
  const file = readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.(md|txt))?$/i.test(f));
  if (!file) return "";
  const lines = readFileSync(path.join(dir, file), "utf-8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^(copyright\b|\(c\)\s|©)/i.test(l));
  return [...new Set(lines)].slice(0, 3).join(" / ");
}

const pkgs = [];
for (const [key, meta] of Object.entries(lock.packages)) {
  if (!key.startsWith("node_modules/") || meta.dev || meta.devOptional) continue;
  const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
  let license = licenseOf(meta);
  const dir = path.join(repoRoot, key);
  if (license === "UNKNOWN" && existsSync(path.join(dir, "package.json"))) {
    license = licenseOf(JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8")));
  }
  pkgs.push({ name, version: meta.version, license, copyright: copyrightOf(dir) });
}
pkgs.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, "en", { numeric: true }));

const fingerprint = createHash("sha256")
  .update(pkgs.map((p) => `${p.name}@${p.version}:${p.license}`).join("\n"))
  .digest("hex");

// Human-readable names/homepages/licenses for the install-time downloads,
// keyed by versions.json key. A key missing here is still listed (with its
// URL origin and "see publisher"), so a new pin never breaks the generator.
const APPS = {
  "7zr": ["7-Zip (7zr)", "https://www.7-zip.org/", "LGPL-2.1-or-later (with unRAR restriction)"],
  azahar: ["Azahar", "https://github.com/azahar-emu/azahar", "GPL-2.0-or-later"],
  cemu: ["Cemu", "https://github.com/cemu-project/Cemu", "MPL-2.0"],
  cloudflared: ["cloudflared", "https://github.com/cloudflare/cloudflared", "Apache-2.0"],
  dolphin: ["Dolphin", "https://dolphin-emu.org/", "GPL-2.0-or-later"],
  duckstation: ["DuckStation", "https://github.com/stenzek/duckstation", "see publisher"],
  esde: ["ES-DE (EmulationStation Desktop Edition)", "https://es-de.org/", "MIT"],
  flycast: ["Flycast", "https://github.com/flyinghead/flycast", "GPL-2.0-only"],
  lichii: ["Lichii", "https://github.com/zortos293/Lichii", "GPL-3.0-or-later"],
  iconic: ["Iconic (ES-DE theme)", "https://github.com/Siddy212/iconic-es-de", "see publisher"],
  melonds: ["melonDS", "https://melonds.kuribo64.net/", "GPL-3.0-only"],
  mesa: ["Mesa 3D (mesa-dist-win)", "https://github.com/pal1000/mesa-dist-win", "MIT (Mesa); see publisher"],
  pcsx2: ["PCSX2", "https://pcsx2.net/", "GPL-3.0-or-later"],
  ppsspp: ["PPSSPP", "https://www.ppsspp.org/", "GPL-2.0-or-later"],
  retroarch: ["RetroArch", "https://www.retroarch.com/", "GPL-3.0-or-later"],
  "retroarch-cores": ["libretro cores for RetroArch", "https://www.libretro.com/", "various (per core)"],
  rpcs3: ["RPCS3", "https://rpcs3.net/", "GPL-2.0-only"],
  shadps4: ["shadPS4", "https://github.com/shadps4-emu/shadPS4", "GPL-2.0-or-later"],
  sunshine: ["Sunshine", "https://github.com/LizardByte/Sunshine", "GPL-3.0-only"],
  vdd: ["Virtual Display Driver", "https://github.com/VirtualDrivers/Virtual-Display-Driver", "MIT"],
  vigembus: ["ViGEmBus", "https://github.com/nefarius/ViGEmBus", "BSD-3-Clause (see publisher)"],
  vita3k: ["Vita3K", "https://vita3k.org/", "GPL-2.0-only"],
  xemu: ["xemu", "https://xemu.app/", "GPL-2.0-only"],
  xenia: ["Xenia Canary", "https://github.com/xenia-canary/xenia-canary", "BSD-3-Clause"],
  xusb: ["Xbox 360 controller driver (xusb21)", "https://www.catalog.update.microsoft.com/", "Microsoft proprietary, from Windows Update"],
};

const apps = Object.entries(versions.downloads)
  .map(([key, d]) => {
    const [name, home, lic] = APPS[key] ?? [d.name ?? key, new URL(d.url).origin, "see publisher"];
    return { name, home, lic, version: d.version, url: d.url };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const esc = (s) => String(s).replace(/\|/g, "\\|");

const text = [
  "# Third-party notices",
  "",
  `Luma Arcade ${rootPkg.version} is licensed under ${rootPkg.license} (see \`LICENSE\`). It includes, or at install time downloads, the third-party software listed below. Each component remains under its own license.`,
  "",
  "This file is generated by `node installer/notices.mjs` (`npm run notices`); do not edit it by hand.",
  "",
  "## Node.js runtime",
  "",
  "The installer bundles the Node.js runtime (`node.exe`), which runs the Luma Arcade server. Node.js is released under the MIT license; Copyright Node.js contributors and Joyent, Inc. Node.js itself bundles further third-party components (V8, OpenSSL, ICU, libuv, zlib and others) under their own licenses. The complete list and license texts are in the Node.js `LICENSE` file: https://github.com/nodejs/node/blob/main/LICENSE",
  "",
  "## moonlight-web-stream (GPL-3.0)",
  "",
  "The installer bundles a customized build of moonlight-web-stream (`web-server.exe`, `streamer.exe` and its web UI) as `moonlight-web-stream\\` in the install folder. moonlight-web-stream is licensed under the GNU General Public License v3.0 (https://www.gnu.org/licenses/gpl-3.0.html), and the customized build is distributed under the same license.",
  "",
  "- Source code: https://github.com/Luma-exe/moonlight-web-stream-luma",
  "- The exact source for the build shipped in a given Luma Arcade release is the matching tag in that repository (the release notes name it).",
  "- The upstream project is https://github.com/MrCreativ3001/moonlight-web-stream. The executables are built from Rust crates, each under its own license (mostly MIT / Apache-2.0); see `Cargo.lock` in the source repository.",
  "",
  "## Downloaded at install time (not redistributed)",
  "",
  "The Luma Arcade installer does not contain the applications below. When you choose to install them, the installer downloads each one directly from its publisher's servers, checks it against the SHA-256 recorded in `installer/scripts/versions.json`, and installs it on your PC. They are neither bundled in nor redistributed by Luma Arcade, and their licenses are between you and their publishers. License names here are for orientation only; consult each publisher for the authoritative terms.",
  "",
  "| Software | Pinned version | Homepage | License | Downloaded from |",
  "| --- | --- | --- | --- | --- |",
  ...apps.map((a) => `| ${esc(a.name)} | ${esc(a.version)} | ${a.home} | ${esc(a.lic)} | ${a.url} |`),
  "",
  "## npm packages bundled in the server",
  "",
  `The Luma Arcade server bundles these ${pkgs.length} production npm packages (including transitive dependencies) in \`server\\node_modules\`.`,
  "",
  "| Package | Version | License | Copyright |",
  "| --- | --- | --- | --- |",
  ...pkgs.map((p) => `| ${esc(p.name)} | ${p.version} | ${esc(p.license)} | ${esc(p.copyright)} |`),
  "",
  `<!-- notices-fingerprint: ${fingerprint} -->`,
  "",
].join("\n");

if (process.argv.includes("--check")) {
  const current = existsSync(outFile) ? readFileSync(outFile, "utf-8") : "";
  const m = current.match(FP);
  const appsOk = apps.every((a) => current.includes(`| ${esc(a.name)} | ${esc(a.version)} |`));
  if (!m || m[1] !== fingerprint || !appsOk) {
    console.error("THIRD-PARTY-NOTICES.md is stale: run `npm run notices` and commit the result.");
    process.exit(1);
  }
  console.log("THIRD-PARTY-NOTICES.md is up to date.");
} else {
  writeFileSync(outFile, text, "utf-8");
  console.log(`Wrote ${outFile} (${pkgs.length} npm packages, ${apps.length} downloaded apps).`);
}
