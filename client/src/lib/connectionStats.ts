export interface ConnectionStats {
  bitrateKbps: number;
  rttMs: number | null;
  packetLossPct: number;
}

let lastBytesReceived = 0;
let lastTimestamp = 0;

export async function sampleConnectionStats(
  pc: RTCPeerConnection
): Promise<ConnectionStats | null> {
  const report = await pc.getStats();
  let bytesReceived = 0;
  let packetsReceived = 0;
  let packetsLost = 0;
  let rttMs: number | null = null;
  let timestamp = 0;

  report.forEach((stat) => {
    if (stat.type === "inbound-rtp" && stat.kind === "video") {
      bytesReceived = stat.bytesReceived ?? 0;
      packetsReceived = stat.packetsReceived ?? 0;
      packetsLost = stat.packetsLost ?? 0;
      timestamp = stat.timestamp;
    }
    if (stat.type === "candidate-pair" && stat.state === "succeeded") {
      if (typeof stat.currentRoundTripTime === "number") {
        rttMs = stat.currentRoundTripTime * 1000;
      }
    }
  });

  let bitrateKbps = 0;
  if (lastTimestamp && timestamp > lastTimestamp) {
    const deltaBytes = bytesReceived - lastBytesReceived;
    const deltaSeconds = (timestamp - lastTimestamp) / 1000;
    bitrateKbps = Math.max(0, (deltaBytes * 8) / 1000 / deltaSeconds);
  }
  lastBytesReceived = bytesReceived;
  lastTimestamp = timestamp;

  const totalPackets = packetsReceived + packetsLost;
  const packetLossPct = totalPackets > 0 ? (packetsLost / totalPackets) * 100 : 0;

  return { bitrateKbps, rttMs, packetLossPct };
}
