import { getSetting } from "../config/settings.js";

// The arcade's news in a Discord channel (settings: discordWebhookUrl).
// Nothing is sent while that's empty.

const WEBHOOK = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

export function isDiscordWebhook(url: string): boolean {
  return WEBHOOK.test(url);
}

/** When each throttled kind of message last went out. */
const lastSent = new Map<string, number>();

/**
 * Posts `text`. With `key`, the same key isn't posted again within `everyMs`
 * (a quality switch restarts the stream; that's not news). Resolves to
 * whether it was posted. Never throws.
 */
export async function notify(
  text: string,
  key?: string,
  everyMs = 0,
  now = Date.now(),
  /** Discord user ids this message may ping (written as <@id> in text). */
  ping: string[] = []
): Promise<boolean> {
  const url = getSetting("discordWebhookUrl");
  if (!url || !isDiscordWebhook(url)) return false;
  if (key) {
    const last = lastSent.get(key);
    if (last !== undefined && now - last < everyMs) return false;
    lastSent.set(key, now);
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Only the pings asked for: nobody's text can @everyone through here.
      body: JSON.stringify({ username: "Luma Arcade", content: text.slice(0, 1900), allowed_mentions: { parse: [], users: ping } }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Tests. */
export function resetNotify(): void {
  lastSent.clear();
}
