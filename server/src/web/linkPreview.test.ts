import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isPreviewBot, previewPage, previewTags } from "./linkPreview.js";

describe("link previews", () => {
  it("knows the preview bots of the apps people paste links into", () => {
    assert.ok(isPreviewBot("Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)"));
    assert.ok(isPreviewBot("WhatsApp/2.23.20.0 A"));
    assert.ok(isPreviewBot("facebookexternalhit/1.1 Facebot Twitterbot/1.0"));
    assert.ok(isPreviewBot("TelegramBot (like TwitterBot)"));
    assert.ok(isPreviewBot("Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)"));
  });

  it("leaves real browsers alone", () => {
    assert.ok(!isPreviewBot("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"));
    assert.ok(!isPreviewBot("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0"));
    assert.ok(!isPreviewBot(undefined));
  });

  it("points the image at the site the link came from, and escapes titles", () => {
    const tags = previewTags({ title: 'Play "Tom & Jerry"', description: "d", url: "https://a.example/g/x", origin: "https://a.example" });
    assert.match(tags, /og:image" content="https:\/\/a\.example\/stream\/resources\/luma-star-512\.png"/);
    assert.match(tags, /og:title" content="Play &quot;Tom &amp; Jerry&quot;"/);
    assert.match(previewPage({ title: "t", description: "d", url: "u", origin: "o" }), /og:description" content="d"/);
  });
});
