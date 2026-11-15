import { request as httpsRequest } from "node:https";
import { readData } from "../remote/moonlightData.js";

// Talking to Sunshine the way Moonlight does: its HTTPS port, with the
// client certificate moonlight-web-stream paired with (data.json).
export const SUNSHINE_HTTPS_PORT = 47984;

function pairedClient(): { key: string; cert: string } | null {
  try {
    for (const host of Object.values(readData().hosts ?? {})) {
      const pair = host.pair_info as { client_private_key?: string; client_certificate?: string } | undefined;
      if (pair?.client_private_key && pair.client_certificate && /^(localhost|127\.0\.0\.1|::1)$/.test(host.address)) {
        return { key: pair.client_private_key, cert: pair.client_certificate };
      }
    }
  } catch {}
  return null;
}

export type SunshineAnswer = { status: "ok"; code: number; body: string } | { status: "hung" } | { status: "unpaired" };

/** GET a Sunshine HTTPS path. "hung" when the handshake or reply never comes.
 * host: another paired Sunshine (an extra seat, seats.ts) - they all trust
 * the same client certificate. */
export function sunshineGet(path: string, timeoutMs = 5000, host = "127.0.0.1"): Promise<SunshineAnswer> {
  const client = pairedClient();
  if (!client) return Promise.resolve({ status: "unpaired" });
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        host,
        port: SUNSHINE_HTTPS_PORT,
        path,
        key: client.key,
        cert: client.cert,
        // Sunshine's certificate is self-signed.
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: "ok", code: res.statusCode ?? 0, body }));
        res.on("error", () => resolve({ status: "hung" }));
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: "hung" });
    });
    req.on("error", () => resolve({ status: "hung" }));
    req.end();
  });
}

/** Does Sunshine's HTTPS port finish a request? (Host Health, auto-restart) */
export async function sunshineHttps(): Promise<"ok" | "hung" | "unpaired"> {
  return (await sunshineGet("/serverinfo")).status;
}

// --- app names (Sunshine's apps have numeric ids; the play log wants names)

let appNames: { at: number; names: Map<number, string> } | null = null;
/** When the app list was last asked for, successful or not. */
let lastAsk = -Infinity;
const APP_NAMES_MS = 10 * 60_000;
/** An app that isn't in the list (or a list that won't load) is asked for
 * again at most this often. */
const MISSING_RETRY_MS = 30_000;

/** The list fetch and clock, swappable so tests don't need Sunshine. */
export const appListSource = {
  get: (): Promise<SunshineAnswer> => sunshineGet("/applist?uniqueid=0123456789ABCDEF"),
  now: (): number => Date.now(),
};

let inFlight: Promise<void> | null = null;

/** Tests. */
export function resetAppNames(): void {
  appNames = null;
  lastAsk = -Infinity;
  inFlight = null;
}

/** Sunshine's apps just changed (e.g. PC games imported): the next lookup of
 * a missing app asks again at once instead of waiting out MISSING_RETRY_MS. */
export function forgetAppListMisses(): void {
  lastAsk = -Infinity;
}

/** The name from the last app list, without asking (null if not seen). */
export function knownAppName(appId: number): string | null {
  return appNames?.names.get(appId) ?? null;
}

/** Fetches the app list when it's old, or when something is missing from it
 * (unless that was already tried within MISSING_RETRY_MS). */
async function refreshAppList(missing: boolean): Promise<void> {
  // Lookups made while the list is loading wait for that one fetch.
  if (inFlight) return inFlight;
  const now = appListSource.now();
  const stale = !appNames || now - appNames.at > APP_NAMES_MS;
  if (!stale && !missing) return;
  if (now - lastAsk < MISSING_RETRY_MS) return;
  lastAsk = now;
  inFlight = (async () => {
    const answer = await appListSource.get();
    if (answer.status === "ok" && answer.code === 200) appNames = { at: now, names: parseAppList(answer.body) };
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** The Sunshine app with this id's name, or null if Sunshine doesn't say. */
export async function sunshineAppName(appId: number): Promise<string | null> {
  await refreshAppList(!appNames?.names.has(appId));
  return appNames?.names.get(appId) ?? null;
}

/** The id of the Sunshine app with this name (e.g. "ES-DE"). */
export async function sunshineAppId(name: string): Promise<number | null> {
  const known = appNames && [...appNames.names.values()].includes(name);
  await refreshAppList(!known);
  for (const [id, n] of appNames?.names ?? []) if (n === name) return id;
  return null;
}

export function parseAppList(xml: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const m of xml.matchAll(/<App>([\s\S]*?)<\/App>/g)) {
    const title = /<AppTitle>([^<]*)<\/AppTitle>/.exec(m[1])?.[1];
    const id = Number(/<ID>(\d+)<\/ID>/.exec(m[1])?.[1]);
    if (title && Number.isSafeInteger(id)) names.set(id, title.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
  }
  return names;
}
