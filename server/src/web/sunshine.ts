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
const APP_NAMES_MS = 10 * 60_000;

/** The name from the last app list, without asking (null if not seen). */
export function knownAppName(appId: number): string | null {
  return appNames?.names.get(appId) ?? null;
}

/** The Sunshine app with this id's name, or null if Sunshine doesn't say. */
export async function sunshineAppName(appId: number): Promise<string | null> {
  if (!appNames || Date.now() - appNames.at > APP_NAMES_MS || !appNames.names.has(appId)) {
    const answer = await sunshineGet("/applist?uniqueid=0123456789ABCDEF");
    if (answer.status === "ok" && answer.code === 200) appNames = { at: Date.now(), names: parseAppList(answer.body) };
  }
  return appNames?.names.get(appId) ?? null;
}

/** The id of the Sunshine app with this name (e.g. "ES-DE"). */
export async function sunshineAppId(name: string): Promise<number | null> {
  if (!appNames || ![...appNames.names.values()].includes(name)) await sunshineAppName(-1);
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
