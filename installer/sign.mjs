// Optional Authenticode signing. Off unless configured through the environment.
//
//   node installer/sign.mjs <file> [<file>...]
//
// Mode (a): signtool with a certificate
//   LUMA_SIGN_THUMBPRINT           SHA-1 thumbprint of a cert in the Windows cert store
//   or LUMA_SIGN_PFX + LUMA_SIGN_PASSWORD   a .pfx file and its password
//   LUMA_SIGN_TIMESTAMP_URL        RFC 3161 timestamp server (default http://timestamp.digicert.com)
//
// Mode (b): Azure Trusted Signing (signtool /dlib)
//   LUMA_TRUSTED_SIGNING_METADATA  path to the metadata.json (Endpoint, CodeSigningAccountName, CertificateProfileName)
//   LUMA_TRUSTED_SIGNING_DLIB      Azure.CodeSigning.Dlib.dll (optional: looked up in the usual install folders)
//   LUMA_SIGN_TIMESTAMP_URL        default http://timestamp.acs.microsoft.com
//   Azure credentials come from the standard AZURE_* environment variables
//   (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET) or a signed-in az CLI.
//
// Either mode: LUMA_SIGNTOOL points at signtool.exe (otherwise PATH, then the Windows SDK).
//
// With nothing configured this prints "unsigned build" and exits 0. When
// something IS configured, a signing failure is an error (exit 1): a build
// that was meant to be signed never silently ships unsigned.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;

export function signingMode() {
  if (env.LUMA_TRUSTED_SIGNING_METADATA) return "trusted-signing";
  if (env.LUMA_SIGN_THUMBPRINT) return "thumbprint";
  if (env.LUMA_SIGN_PFX) return "pfx";
  return null;
}

function newestChild(dir, pick) {
  if (!existsSync(dir)) return null;
  const versions = readdirSync(dir).sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  for (const v of versions) {
    const p = pick(path.join(dir, v));
    if (p && existsSync(p)) return p;
  }
  return null;
}

function findSigntool() {
  if (env.LUMA_SIGNTOOL) {
    if (!existsSync(env.LUMA_SIGNTOOL)) throw new Error(`LUMA_SIGNTOOL points at ${env.LUMA_SIGNTOOL}, which doesn't exist`);
    return env.LUMA_SIGNTOOL;
  }
  const where = spawnSync("where", ["signtool.exe"], { encoding: "utf-8" });
  if (where.status === 0 && where.stdout.trim()) return where.stdout.split(/\r?\n/)[0].trim();
  for (const base of [env["ProgramFiles(x86)"], env.ProgramFiles].filter(Boolean)) {
    const found = newestChild(path.join(base, "Windows Kits", "10", "bin"), (d) => path.join(d, "x64", "signtool.exe"));
    if (found) return found;
  }
  throw new Error("signtool.exe not found: install the Windows SDK or set LUMA_SIGNTOOL");
}

function findDlib() {
  if (env.LUMA_TRUSTED_SIGNING_DLIB) return env.LUMA_TRUSTED_SIGNING_DLIB;
  const local = env.LOCALAPPDATA;
  const candidates = [
    local && path.join(local, "Microsoft", "MicrosoftTrustedSigningClientTools", "Azure.CodeSigning.Dlib.dll"),
    local && path.join(local, "Microsoft", "MicrosoftArtifactSigningClientTools", "Azure.CodeSigning.Dlib.dll"),
    local && path.join(local, "Microsoft", "TrustedSigning", "Azure.CodeSigning.Dlib.dll"),
  ].filter(Boolean);
  const hit = candidates.find((c) => existsSync(c));
  if (hit) return hit;
  throw new Error("Azure.CodeSigning.Dlib.dll not found: install the Trusted Signing client tools or set LUMA_TRUSTED_SIGNING_DLIB");
}

function buildArgs(mode, files) {
  const base = ["sign", "/fd", "SHA256", "/td", "SHA256"];
  if (mode === "trusted-signing") {
    const meta = env.LUMA_TRUSTED_SIGNING_METADATA;
    if (!existsSync(meta)) throw new Error(`LUMA_TRUSTED_SIGNING_METADATA points at ${meta}, which doesn't exist`);
    return [...base, "/tr", env.LUMA_SIGN_TIMESTAMP_URL || "http://timestamp.acs.microsoft.com", "/dlib", findDlib(), "/dmdf", meta, ...files];
  }
  const tr = ["/tr", env.LUMA_SIGN_TIMESTAMP_URL || "http://timestamp.digicert.com"];
  if (mode === "thumbprint") return [...base, ...tr, "/sha1", env.LUMA_SIGN_THUMBPRINT, ...files];
  if (!existsSync(env.LUMA_SIGN_PFX)) throw new Error(`LUMA_SIGN_PFX points at ${env.LUMA_SIGN_PFX}, which doesn't exist`);
  const pw = env.LUMA_SIGN_PASSWORD ? ["/p", env.LUMA_SIGN_PASSWORD] : [];
  return [...base, ...tr, "/f", env.LUMA_SIGN_PFX, ...pw, ...files];
}

// Signs the files. Returns false (after printing "unsigned build") when
// signing isn't configured; throws if it is configured and fails.
export function signFiles(files) {
  const mode = signingMode();
  if (!mode) {
    console.log(`unsigned build (no signing configured): ${files.map((f) => path.basename(f)).join(", ")}`);
    return false;
  }
  for (const f of files) if (!existsSync(f)) throw new Error(`Can't sign ${f}: file not found`);
  const signtool = findSigntool();
  const args = buildArgs(mode, files);
  // Never echo the PFX password.
  const shown = args.map((a, i) => (args[i - 1] === "/p" ? "****" : a));
  console.log(`> signtool (${mode}) ${shown.join(" ")}`);
  const r = spawnSync(signtool, args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`signtool failed (exit ${r.status}) signing ${files.join(", ")}`);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2).filter(Boolean);
  if (!files.length) {
    console.error("usage: node installer/sign.mjs <file> [<file>...]");
    process.exit(2);
  }
  try {
    signFiles(files.map((f) => path.resolve(f)));
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(1);
  }
}
