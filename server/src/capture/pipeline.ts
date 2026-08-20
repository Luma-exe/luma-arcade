export interface PipelineOptions {
  signallingUri: string; // ws://127.0.0.1:<port>/signalling
  framerate?: number;
  bitrateKbps?: number;
  stunServer?: string; // stun://host:port
  turnServer?: string; // turn://user:pass@host:port
}

function webrtcSinkArgs(opts: PipelineOptions): string[] {
  const args = [
    "webrtcsink",
    "name=ws",
    `signaller::uri=${opts.signallingUri}`,
    "video-caps=video/x-h264",
    "do-fec=false",
    "bind-address=127.0.0.1",
  ];
  if (opts.stunServer) args.push(`stun-server=${opts.stunServer}`);
  if (opts.turnServer) args.push(`turn-servers=<"${opts.turnServer}">`);
  return args.concat(bitrateArg(opts.bitrateKbps ?? 8000));
}

/**
 * Full-desktop capture pipeline: D3D11 screen capture -> webrtcsink.
 * webrtcsink negotiates its own encoder; on an NVIDIA machine with the
 * gst-plugins-bad nv codecs installed it will prefer nvh264enc automatically.
 * video-caps pins the output to H.264 per the brief's Phase-1 codec choice.
 */
export function buildFullDesktopPipelineArgs(opts: PipelineOptions): string[] {
  const framerate = opts.framerate ?? 60;

  return [
    "-v",
    "d3d11screencapturesrc",
    "show-cursor=true",
    "!",
    `video/x-raw(memory:D3D11Memory),framerate=${framerate}/1`,
    "!",
    "queue",
    "leaky=downstream",
    "max-size-buffers=2",
    "!",
    ...webrtcSinkArgs(opts),
  ];
}

/**
 * Captures a single window by HWND instead of the whole monitor.
 * Requires a GStreamer build whose d3d11screencapturesrc supports the
 * `window-handle` property — verify with `gst-inspect-1.0 d3d11screencapturesrc`.
 * Callers should catch pipeline failure and fall back to full-desktop capture.
 */
export function buildWindowCapturePipelineArgs(
  opts: PipelineOptions & { windowHandle: string }
): string[] {
  const framerate = opts.framerate ?? 60;

  return [
    "-v",
    "d3d11screencapturesrc",
    `window-handle=${opts.windowHandle}`,
    "show-cursor=true",
    "!",
    `video/x-raw(memory:D3D11Memory),framerate=${framerate}/1`,
    "!",
    "queue",
    "leaky=downstream",
    "max-size-buffers=2",
    "!",
    ...webrtcSinkArgs(opts),
  ];
}

function bitrateArg(_bitrateKbps: number): string[] {
  // webrtcsink picks its own encoder's bitrate property dynamically; exposed
  // as a follow-up once the concrete encoder element (nvh264enc vs x264enc)
  // is confirmed on the target machine. Left as a no-op arg list for now.
  return [];
}
