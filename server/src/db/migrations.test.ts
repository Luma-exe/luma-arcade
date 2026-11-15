import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb } from "./index.js";
import { getSetting } from "../config/settings.js";

const MIGRATION = "017_admin_discord_and_private.sql";
let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "luma-db-"));
  file = path.join(dir, "test.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** An install from before the migration: everything applied except it. */
function oldInstall(settings: Record<string, string>): void {
  const db = initDb(file);
  db.prepare("DELETE FROM schema_migrations WHERE name = ?").run(MIGRATION);
  db.exec("DELETE FROM settings");
  for (const [key, value] of Object.entries(settings)) db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, value);
  db.close();
}

describe("settings defaults migration", () => {
  it("a brand new install is private and mentions nobody", () => {
    const db = initDb(file);
    assert.equal(getSetting("privateServer"), true);
    assert.equal(getSetting("adminDiscordId"), "");
    const rows = db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key IN ('privateServer','adminDiscordId')").get() as { n: number };
    assert.equal(rows.n, 0);
    db.close();
  });

  it("an existing install keeps its public sign-up form, and a webhook keeps the old ping", () => {
    oldInstall({ discordWebhookUrl: JSON.stringify("https://discord.com/api/webhooks/1/abc") });
    const db = initDb(file);
    assert.equal(getSetting("privateServer"), false);
    assert.equal(getSetting("adminDiscordId"), "851332798231871508");
    db.close();
  });

  it("an existing install without a webhook pings nobody", () => {
    oldInstall({ discordWebhookUrl: '""' });
    const db = initDb(file);
    assert.equal(getSetting("adminDiscordId"), "");
    assert.equal(getSetting("privateServer"), false);
    db.close();
  });

  it("does not overwrite a value the owner already saved", () => {
    oldInstall({ privateServer: "true", adminDiscordId: '"12345"', discordWebhookUrl: JSON.stringify("https://discord.com/api/webhooks/1/abc") });
    const db = initDb(file);
    assert.equal(getSetting("privateServer"), true);
    assert.equal(getSetting("adminDiscordId"), "12345");
    db.close();
  });
});
