import { getSetting } from "../config/settings.js";

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: CachedToken | undefined;

async function getAccessToken(): Promise<string | undefined> {
  const clientId = getSetting("igdbClientId");
  const clientSecret = getSetting("igdbClientSecret");
  if (!clientId || !clientSecret) return undefined;

  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.accessToken;
  }

  const url = new URL("https://id.twitch.tv/oauth2/token");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("client_secret", clientSecret);
  url.searchParams.set("grant_type", "client_credentials");

  const res = await fetch(url, { method: "POST" });
  if (!res.ok) return undefined;

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return cachedToken.accessToken;
}

/** Best-effort cover lookup by title; returns undefined on any failure (no key set, no match, network error). */
export async function fetchBoxArtUrl(title: string): Promise<string | undefined> {
  const clientId = getSetting("igdbClientId");
  const accessToken = await getAccessToken();
  if (!clientId || !accessToken) return undefined;

  try {
    const escaped = title.replace(/"/g, '\\"');
    const res = await fetch("https://api.igdb.com/v4/games", {
      method: "POST",
      headers: {
        "Client-ID": clientId,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "text/plain",
      },
      body: `search "${escaped}"; fields name,cover.image_id; limit 1;`,
    });
    if (!res.ok) return undefined;

    const results = (await res.json()) as Array<{ cover?: { image_id: string } }>;
    const imageId = results[0]?.cover?.image_id;
    if (!imageId) return undefined;

    return `https://images.igdb.com/igdb/image/upload/t_cover_big/${imageId}.jpg`;
  } catch {
    return undefined;
  }
}
