import type { StreamUser } from "./streamUser.js";

// Messages from an admin to one person ("5 more minutes!"), shown on their
// stream page or home screen the next time it checks (every few seconds).
// Kept in memory: undelivered ones are lost if LumaArcade restarts.

export interface Message {
  id: number;
  from: string;
  text: string;
  at: number;
}

const MAX_TEXT = 300;
/** Undelivered messages this old are dropped. */
const KEEP_MS = 60 * 60_000;

let nextId = 1;
const pending = new Map<number, Message[]>();

export function sendMessage(to: number, from: StreamUser, text: unknown, now = Date.now()): Message {
  const clean = typeof text === "string" ? text.trim().slice(0, MAX_TEXT) : "";
  if (!clean) throw new Error("Write a message first");
  const message = { id: nextId++, from: from.name, text: clean, at: now };
  pending.set(to, [...(pending.get(to) ?? []), message]);
  return message;
}

/** Hand over (and forget) this person's messages. */
export function takeMessages(userId: number, now = Date.now()): Message[] {
  const list = (pending.get(userId) ?? []).filter((m) => now - m.at < KEEP_MS);
  pending.delete(userId);
  return list;
}

/** Waiting to be picked up, per person (the admin's view). */
export function pendingCount(userId: number): number {
  return pending.get(userId)?.length ?? 0;
}
