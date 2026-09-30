import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FastifyRequest } from "fastify";
import { httpsUpgradeUrl } from "./requestOrigin.js";

function req(remote: string, headers: Record<string, string>, url = "/stream/"): FastifyRequest {
  return { socket: { remoteAddress: remote }, headers: { host: "arcade.example.com", ...headers }, raw: { url } } as unknown as FastifyRequest;
}

describe("https upgrade", () => {
  it("sends plain-http visits through the tunnel to https", () => {
    const r = req("127.0.0.1", { "cf-connecting-ip": "1.2.3.4", "cf-visitor": '{"scheme":"http"}' }, "/stream/?a=1");
    assert.equal(httpsUpgradeUrl(r), "https://arcade.example.com/stream/?a=1");
  });

  it("leaves https visits and the home network alone", () => {
    assert.equal(httpsUpgradeUrl(req("127.0.0.1", { "cf-connecting-ip": "1.2.3.4", "cf-visitor": '{"scheme":"https"}' })), null);
    assert.equal(httpsUpgradeUrl(req("192.168.1.5", { "cf-visitor": '{"scheme":"http"}' })), null);
  });
});
