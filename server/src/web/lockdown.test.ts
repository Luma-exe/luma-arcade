import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lockdownState } from "./lockdown.js";

const admin = { id: 1, name: "Luma", roleId: 1, admin: true };
const sam = { id: 2, name: "Sam", roleId: 2, admin: false };
const ben = { id: 3, name: "Ben", roleId: 2, admin: false };

describe("lockdown", () => {
  it("is off with nobody streaming, or only admins", () => {
    assert.equal(lockdownState([]).on, false);
    assert.equal(lockdownState([admin]).on, false);
  });

  it("is on while anyone without the admin role is connected, even alongside an admin", () => {
    const s = lockdownState([admin, sam, ben], 1000);
    assert.equal(s.on, true);
    assert.equal(s.who, "Sam, Ben");
    assert.equal(s.until, 61_000);
  });
});
