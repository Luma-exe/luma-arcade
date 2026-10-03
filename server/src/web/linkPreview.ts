import type { FastifyRequest } from "fastify";

// What Discord, WhatsApp, iMessage and friends show when someone pastes an
// arcade link: Open Graph tags with the slogan and the Luma star. Their
// preview bots open the link before the person does, so guest links answer
// them with just these tags (routes/guestLinks.ts) - a bot must never sign
// in, use up the link or start a game.

export const SLOGAN = "Your own Cloud Gaming, for you and your friends.";
export const PITCH = "Play this PC's games in your browser - no app to install, no account needed.";

// Link preview fetchers. Apple's (iMessage) borrows facebookexternalhit and
// Twitterbot; Telegram, Slack, Signal and Teams have their own.
const PREVIEW_BOTS =
  /discordbot|whatsapp|facebookexternalhit|facebookcatalog|twitterbot|slackbot|telegrambot|linkedinbot|skypeuripreview|teams|redditbot|embedly|pinterest|vkshare|applebot|google-structured-data|googlebot|bingbot|signal|iframely|mastodon|bluesky|cardyb|snapchat|kakaotalk|viber/i;

export function isPreviewBot(userAgent: string | undefined): boolean {
  return !!userAgent && PREVIEW_BOTS.test(userAgent);
}

/** https://arcade.example.com - as the visitor reached it (behind the tunnel too). */
export function siteOrigin(request: FastifyRequest): string {
  return `${request.protocol}://${request.host}`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export interface Preview {
  title: string;
  description: string;
  /** Absolute address of the page. */
  url: string;
  /** Absolute address of the site, for the image. */
  origin: string;
}

/** The <meta> tags for a page's <head>. */
export function previewTags({ title, description, url, origin }: Preview): string {
  const image = `${origin}/stream/resources/luma-star-512.png`;
  return [
    `<meta property="og:site_name" content="Luma Arcade">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    `<meta property="og:image:width" content="512">`,
    `<meta property="og:image:height" content="512">`,
    `<meta name="twitter:card" content="summary">`,
  ].join("\n");
}

/** Fills a page's <!--link-preview--> placeholder. */
export function withPreview(html: string, request: FastifyRequest, title: string, description: string): string {
  const origin = siteOrigin(request);
  const url = origin + request.url.split("?")[0];
  return html.replace("<!--link-preview-->", previewTags({ title, description, url, origin }));
}

/** A whole page with just the preview, for a bot opening a guest link. */
export function previewPage(preview: Preview): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(preview.title)}</title>
<meta name="description" content="${esc(preview.description)}">
${previewTags(preview)}
</head><body><h1>${esc(preview.title)}</h1><p>${esc(preview.description)}</p></body></html>`;
}
