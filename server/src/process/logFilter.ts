/** Splits a child's output into lines and drops the ones that are only
 * noise, so the log keeps what's worth reading. Chunks arrive cut anywhere;
 * a partial last line waits for the rest. */
export class LineFilter {
  private pending = "";
  /** Inside a multi-line block that's being dropped. */
  private skipping = false;

  constructor(
    private readonly rules: {
      drop: RegExp[];
      /** A block from `start` up to and including the first line matching `end`. */
      blocks?: { start: RegExp; end: RegExp }[];
    }
  ) {}

  /** The chunk's complete lines that are kept, each ending in "\n". */
  push(chunk: string): string {
    const text = this.pending + chunk;
    const lines = text.split("\n");
    this.pending = lines.pop() ?? "";
    let out = "";
    for (const line of lines) {
      if (this.keep(line)) out += `${line}\n`;
    }
    return out;
  }

  private keep(line: string): boolean {
    if (this.skipping) {
      if (this.rules.blocks?.some((b) => b.end.test(line))) this.skipping = false;
      return false;
    }
    const block = this.rules.blocks?.find((b) => b.start.test(line));
    if (block) {
      this.skipping = !block.end.test(line);
      return false;
    }
    return !this.rules.drop.some((re) => re.test(line));
  }
}

/** moonlight-web-stream's noise, as seen in a day's log (2026-09-29): */
export const MOONLIGHT_LOG_RULES = {
  drop: [
    // A page asking its API without being signed in (answered 401 anyway).
    /SessionTokenNotFound/,
    // Browsers offer DTLS extensions webrtc-rs doesn't know; harmless.
    /Unsupported Extension Type/,
    // Tail ends of a stream closing.
    /because of missing stream/,
    /Failed to close candidate .*the agent is closed/,
    // The PC's side can't use TURN over TCP/TLS; browsers still get those
    // servers (they need them on strict networks).
    /Unable to handle URL in gather_candidates_relay/,
    /could not get server reflexive address \S+ turns?:/,
    // Adapters without a usable address (Hyper-V/WSL switches).
    /could not listen udp .*not valid in its context/,
  ],
  blocks: [
    // Every stream's WebSocket request, printed header by header (luma logs
    // "stream started" with the player's name instead).
    { start: /INFO start_host\{request=\s*$/, end: /\}: web_server::api::stream: close/ },
  ],
};
