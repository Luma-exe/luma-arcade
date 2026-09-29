import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDb, initDb } from "../db/index.js";
import { applyEvent, coverFile, resetGames } from "./games.js";
import { publicPlaying } from "./routes/games.js";
import { resetSessions, streamStarted } from "./sessions.js";

let media: string;
before(() => {
  initDb(":memory:");
  media = mkdtempSync(path.join(tmpdir(), "luma-media-"));
  mkdirSync(path.join(media, "xbox360", "covers", "Disc Games"), { recursive: true });
  writeFileSync(path.join(media, "xbox360", "covers", "Disc Games", "Halo 3.png"), "png");
  mkdirSync(path.join(media, "steam", "miximages"), { recursive: true });
  writeFileSync(path.join(media, "steam", "miximages", "Rocket League.jpg"), "jpg");
});
beforeEach(() => {
  resetSessions();
  resetGames();
  getDb().exec("DELETE FROM game_plays; DELETE FROM user_prefs; DELETE FROM play_sessions;");
});

describe("cover art", () => {
  it("finds ES-DE's picture from the ROM's folders and name", () => {
    assert.equal(
      coverFile({ rom: String.raw`G:\ES-DE\ROMs\xbox360\Disc Games\Halo 3.iso`, system: "xbox360" }, media),
      path.join(media, "xbox360", "covers", "Disc Games", "Halo 3.png")
    );
    // no cover: a mix image will do
    assert.equal(
      coverFile({ rom: String.raw`G:\ES-DE\ROMs\steam\Rocket League.url`, system: "steam" }, media),
      path.join(media, "steam", "miximages", "Rocket League.jpg")
    );
  });

  it("finds nothing for games without art, or paths that climb out", () => {
    assert.equal(coverFile({ rom: String.raw`G:\ES-DE\ROMs\xbox360\Forza.iso`, system: "xbox360" }, media), null);
    assert.equal(coverFile({ rom: String.raw`G:\ES-DE\ROMs\xbox360\..\..\x.png`, system: "xbox360" }, media), null);
    assert.equal(coverFile({ rom: null, system: null }, media), null);
  });
});

describe("now playing on the welcome page", () => {
  const sam = { id: 2, name: "Sam", roleId: 2, admin: false };

  it("says nothing about people who didn't opt in", () => {
    streamStarted({ close() {} }, sam);
    applyEvent({ event: "start", id: "g", at: Date.now(), name: "FIFA 23" }, false);
    assert.deepEqual(publicPlaying(), []);
  });

  it("shows the name and game of people who did", () => {
    streamStarted({ close() {} }, sam);
    applyEvent({ event: "start", id: "g", at: Date.now(), name: "FIFA 23" }, false);
    getDb().prepare("INSERT INTO user_prefs (user_id, share_playing, updated_at) VALUES (2, 1, 0)").run();
    assert.deepEqual(publicPlaying(), [{ name: "Sam", role: "player", game: "FIFA 23" }]);
  });
});
