import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizedPath } from "./proxyPath.js";

describe("normalizedPath", () => {
  const table: [string, string | null][] = [
    ["/stream/api/login", "/stream/api/login"],
    ["/stream/api/login?x=1", "/stream/api/login"],
    ["/stream/api/%6Cogin", "/stream/api/login"],
    ["/stream/./api/login", "/stream/api/login"],
    ["/stream//api/login", "/stream/api/login"],
    ["/stream/x/../api/login", "/stream/api/login"],
    ["/stream/%2e/api/login", "/stream/api/login"],
    ["/stream/api/%256Cogin", "/stream/api/login"],
    ["/stream\\api\\login", "/stream/api/login"],
    ["/stream/api/%zz", null],
    ["/stream/api/%25252525login", null],
    ["/../../stream/api/login", "/stream/api/login"],
    ["/stream/api/", "/stream/api/"],
    ["/stream/a/..", "/stream/"],
    ["/stream/resources/a%20b.js", "/stream/resources/a b.js"],
  ];
  for (const [raw, want] of table) {
    it(`${raw} -> ${want}`, () => assert.equal(normalizedPath(raw), want));
  }
});
