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

export interface GameMetadata {
  boxArtUrl?: string;
  genre?: string;
  developer?: string;
  releaseYear?: number;
  description?: string;
  rating5?: number;
}

interface IgdbGameResult {
  cover?: { image_id: string };
  genres?: { name: string }[];
  summary?: string;
  aggregated_rating?: number;
  first_release_date?: number;
  involved_companies?: { developer: boolean; company: { name: string } }[];
}

/** Best-effort metadata lookup by title; returns {} on any failure (no key
 * set, no match, network error) rather than throwing — box art / detail
 * panels degrade gracefully when a game just isn't found. */
export async function fetchGameMetadata(title: string): Promise<GameMetadata> {
  const clientId = getSetting("igdbClientId");
  const accessToken = await getAccessToken();
  if (!clientId || !accessToken) return {};

  try {
    const escaped = title.replace(/"/g, '\\"');
    const res = await fetch("https://api.igdb.com/v4/games", {
      method: "POST",
      headers: {
        "Client-ID": clientId,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "text/plain",
      },
      body:
        `search "${escaped}"; fields name,cover.image_id,genres.name,summary,` +
        `aggregated_rating,first_release_date,involved_companies.company.name,` +
        `involved_companies.developer; limit 1;`,
    });
    if (!res.ok) return {};

    const results = (await res.json()) as IgdbGameResult[];
    const game = results[0];
    if (!game) return {};

    const developer =
      game.involved_companies?.find((c) => c.developer)?.company.name ??
      game.involved_companies?.[0]?.company.name;

    return {
      boxArtUrl: game.cover
        ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${game.cover.image_id}.jpg`
        : undefined,
      genre: game.genres?.map((g) => g.name).join(", "),
      developer,
      releaseYear: game.first_release_date
        ? new Date(game.first_release_date * 1000).getUTCFullYear()
        : undefined,
      description: game.summary,
      rating5:
        game.aggregated_rating !== undefined
          ? Math.max(1, Math.min(5, Math.round(game.aggregated_rating / 20)))
          : undefined,
    };
  } catch {
    return {};
  }
}
