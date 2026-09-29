import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LineFilter, MOONLIGHT_LOG_RULES } from "./logFilter.js";

describe("LineFilter", () => {
  it("keeps ordinary lines and drops noise", () => {
    const f = new LineFilter(MOONLIGHT_LOG_RULES);
    const out = f.push(
      "2026 INFO streamer: Trying WebRTC transport\n" +
        "2026 WARN tracing_actix_web::middleware: Error encountered while processing the incoming HTTP request: SessionTokenNotFound\n" +
        "2026 WARN tracing_actix_web::middleware: Error encountered while processing the incoming HTTP request: Unauthorized\n" +
        "2026 WARN dtls::handshake::handshake_message_client_hello: Unsupported Extension Type 0 16\n" +
        "2026 WARN webrtc_ice::agent::agent_gather: [controlling]: could not get server reflexive address udp4 turns:turn.cloudflare.com:443?transport=tcp: deadline has elapsed\n" +
        "2026 WARN webrtc_ice::agent::agent_gather: [controlling]: could not get server reflexive address udp4 stun:stun.l.google.com:19302: deadline has elapsed\n"
    );
    assert.equal(
      out,
      "2026 INFO streamer: Trying WebRTC transport\n" +
        "2026 WARN webrtc_ice::agent::agent_gather: [controlling]: could not get server reflexive address udp4 stun:stun.l.google.com:19302: deadline has elapsed\n"
    );
  });

  it("joins lines split across chunks", () => {
    const f = new LineFilter(MOONLIGHT_LOG_RULES);
    assert.equal(f.push("2026 INFO moonlight: RTSP"), "");
    assert.equal(f.push(" port: 48010\n2026 WARN x: Error encountered while processing the incoming HTTP request: SessionToken"), "2026 INFO moonlight: RTSP port: 48010\n");
    assert.equal(f.push("NotFound\nnext\n"), "next\n");
  });

  it("drops the WebSocket header dump as one block", () => {
    const f = new LineFilter(MOONLIGHT_LOG_RULES);
    const out = f.push(
      "before\n" +
        "2026-09-28T14:39:34.047518Z  INFO start_host{request=\n" +
        "HttpRequest HTTP/1.1 GET:/stream/api/host/stream\n" +
        "  headers:\n" +
        '    "cookie": "*redacted*"\n' +
        " user_id=3001704521}: web_server::api::stream: close time.busy=25.3µs time.idle=6.00µs\n" +
        "after\n"
    );
    assert.equal(out, "before\nafter\n");
  });
});
