import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDb, initDb } from "../db/index.js";
import { IDLE_CLOSE_MS, applyEvent, gameToClose, gamesByApp, lastGameFor, readNewEvents, resetGames, type GameEvent } from "./games.js";
import { playStarted } from "./playLog.js";
import { resetSessions, streamEnded, streamStarted } from "./sessions.js";
import type { StreamUser } from "./streamUser.js";

const alice: StreamUser = { id: 1, name: "Alice", roleId: 2, admin: false };
const T0 = 1_000_000_000;
let file: string;

before(() => {
  initDb(":memory:");
  file = path.join(mkdtempSync(path.join(tmpdir(), "luma-games-")), "games.jsonl");
});
beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: T0 });
  resetSessions();
  resetGames();
  getDb().exec("DELETE FROM game_plays; DELETE FROM play_sessions;");
  writeFileSync(file, "");
});
afterEach(() => mock.timers.reset());

const line = (e: GameEvent) => appendFileSync(file, JSON.stringify(e) + "\n");
const apply = () => readNewEvents(file).forEach((e) => applyEvent(e, false));

describe("games inside ES-DE", () => {
  it("reads whole lines only, and only new ones", () => {
    appendFileSync(file, JSON.stringify({ event: "start", id: "a", at: T0, name: "Halo 3" }) + "\n" + '{"event":"run');
    assert.deepEqual(readNewEvents(file).map((e) => e.id), ["a"]);
    appendFileSync(file, 'ning","id":"a","at":1}\n');
    assert.deepEqual(readNewEvents(file).map((e) => e.event), ["running"]);
    assert.deepEqual(readNewEvents(file), []);
  });

  it("records a game for whoever was streaming, with how to start it again", () => {
    playStarted(alice.id, alice.name, "ES-DE", T0 - 60_000);
    line({ event: "start", id: "g1", at: T0, name: "Halo 3", system: "xbox360", rom: "G:\\ES-DE\\ROMs\\xbox360\\Halo 3.iso" });
    line({ event: "running", id: "g1", at: T0 + 5000, pid: 4242, exe: "G:\\x\\xenia.exe", commandLine: '"G:\\x\\xenia.exe" "G:\\ES-DE\\ROMs\\xbox360\\Halo 3.iso"' });
    line({ event: "end", id: "g1", at: T0 + 30 * 60_000 });
    apply();
    const last = lastGameFor(alice)!;
    assert.equal(last.title, "Halo 3");
    assert.equal(last.userName, "Alice");
    assert.equal(last.pid, 4242);
    assert.match(last.commandLine!, /xenia\.exe/);
    const games = gamesByApp(T0 - 1)!.get("ES-DE")!;
    assert.deepEqual(games.map(({ coverId: _id, ...g }) => g), [{ title: "Halo 3", system: "xbox360", ms: 30 * 60_000, plays: 1 }]);
    assert.equal(games[0].coverId, last.id);
  });

  it("totals each game over several plays, most played first", () => {
    playStarted(alice.id, alice.name, "ES-DE", T0 - 60_000);
    const play = (id: string, name: string, from: number, mins: number) => {
      line({ event: "start", id, at: from, name });
      line({ event: "end", id, at: from + mins * 60_000 });
    };
    play("1", "FIFA 23", T0, 20);
    play("2", "Halo 3", T0 + 21 * 60_000, 5);
    play("3", "FIFA 23", T0 + 27 * 60_000, 10);
    apply();
    const games = gamesByApp(T0 - 1).get("ES-DE")!;
    assert.deepEqual(games.map((g) => [g.title, g.ms / 60_000, g.plays]), [["FIFA 23", 30, 2], ["Halo 3", 5, 1]]);
  });

  it("closes a game only after nobody has streamed for a while", () => {
    const s = { close() {} };
    streamStarted(s, alice);
    line({ event: "start", id: "g", at: T0, name: "Forza" });
    line({ event: "running", id: "g", at: T0, pid: 99 });
    apply();
    assert.equal(gameToClose(), null); // still streaming
    streamEnded(s);
    mock.timers.tick(IDLE_CLOSE_MS - 1000);
    assert.equal(gameToClose(), null);
    mock.timers.tick(2000);
    assert.equal(gameToClose()?.title, "Forza");
  });

  it("names a game from its file when ES-DE gave no name", () => {
    line({ event: "start", id: "x", at: T0, rom: "G:\\ES-DE\\ROMs\\steam\\Rocket League.url" });
    apply();
    assert.equal(gamesByApp(T0 - 1).get("ES-DE")![0].title, "Rocket League");
  });
});
