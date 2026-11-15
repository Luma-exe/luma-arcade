import type { FastifyRequest } from "fastify";

// moonlight-web-stream percent-decodes and normalizes the paths it is sent
// (/stream/api/%6Cogin and /stream/./api/login both reach its login), so
// every gate in the /stream proxy has to look at the path the same way, or
// it can be walked around. Compare with this, never with the raw URL.

const MAX_DECODES = 3;

/** The path a request really names: query stripped, percent-decoding applied
 * until it stops changing, backslashes as slashes, "//" collapsed and "." /
 * ".." resolved. null when it can't be made sense of (malformed escapes,
 * still escaped after several passes). */
export function normalizedPath(rawUrl: string | undefined): string | null {
  let path = (rawUrl ?? "").split("?")[0].split("#")[0];
  let passes = 0;
  for (;;) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return null;
    }
    if (decoded === path) break;
    if (++passes > MAX_DECODES) return null;
    path = decoded;
  }
  path = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const out: string[] = [];
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "..") {
      if (out.length > 1) out.pop();
    } else if (part !== ".") {
      out.push(part);
    }
    // A trailing "." or ".." names a folder: keep the closing slash.
    if ((part === "." || part === "..") && i === parts.length - 1) out.push("");
  }
  return out.join("/") || "/";
}

const memo = new WeakMap<object, string | null>();

/** normalizedPath of a request's URL, worked out once per request. */
export function proxyPath(request: FastifyRequest): string | null {
  if (memo.has(request)) return memo.get(request) ?? null;
  const path = normalizedPath(request.url);
  memo.set(request, path);
  return path;
}
