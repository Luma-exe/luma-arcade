/** The service's error log (NSSM's stderr file) had no times at all, so a
 * crash loop couldn't be placed. Every line written to stderr now starts
 * with the local time. (stdout is pino's JSON, which carries its own.) */
export function timestampStderr(now: () => Date = () => new Date()): void {
  const write = process.stderr.write.bind(process.stderr);
  let atLineStart = true;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const stamped = stampLines(text, atLineStart, localTime(now()));
    atLineStart = text.endsWith("\n");
    return (write as (c: string, ...r: unknown[]) => boolean)(stamped, ...rest);
  }) as typeof process.stderr.write;
}

/** `text` with `stamp` before each line that starts in it. */
export function stampLines(text: string, atLineStart: boolean, stamp: string): string {
  const lines = text.split("\n");
  return lines
    .map((line, i) => ((i === 0 ? atLineStart : true) && line !== "" ? `${stamp} ${line}` : line))
    .join("\n");
}

function localTime(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
