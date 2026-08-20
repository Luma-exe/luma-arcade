/**
 * Hand-rolled PNG-in-ICO generator — no image tooling installed in this
 * environment, so this builds the tray icon bytes directly: a raw RGBA
 * pixel buffer -> a minimal PNG (zlib deflate, no filtering) -> wrapped in
 * a single-entry ICO container. Windows Vista+ supports PNG-compressed
 * icon frames directly inside .ico files, which is what this relies on.
 *
 * Draws a simple filled circle (amber, matching the app's retro accent
 * palette) with a thin teal ring — a real, visible mark instead of the
 * Phase 1 placeholder invisible pixel.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIZE = 32;

const AMBER = [0xe0, 0xa4, 0x58];
const TEAL = [0x4d, 0x8b, 0x8b];

function buildPixels() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const cx = (SIZE - 1) / 2;
  const cy = (SIZE - 1) / 2;
  const outerR = SIZE / 2 - 1;
  const ringInnerR = outerR - 2.5;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const i = (y * SIZE + x) * 4;

      if (dist > outerR) {
        pixels[i + 3] = 0; // transparent outside the circle
      } else if (dist > ringInnerR) {
        pixels[i] = TEAL[0];
        pixels[i + 1] = TEAL[1];
        pixels[i + 2] = TEAL[2];
        pixels[i + 3] = 255;
      } else {
        pixels[i] = AMBER[0];
        pixels[i + 1] = AMBER[1];
        pixels[i + 2] = AMBER[2];
        pixels[i + 3] = 255;
      }
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function buildPng(pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
  for (let y = 0; y < SIZE; y++) {
    const rowStart = y * (1 + SIZE * 4);
    raw[rowStart] = 0; // no filter
    pixels.copy(raw, rowStart + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  const idat = deflateSync(raw);

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function buildIco(pngBuf) {
  const iconDir = Buffer.alloc(6);
  iconDir.writeUInt16LE(0, 0);
  iconDir.writeUInt16LE(1, 2); // type: icon
  iconDir.writeUInt16LE(1, 4); // 1 image

  const entry = Buffer.alloc(16);
  entry[0] = SIZE; // width
  entry[1] = SIZE; // height
  entry[2] = 0; // color count (0 = not palette-based)
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bit count
  entry.writeUInt32LE(pngBuf.length, 8); // bytes in resource
  entry.writeUInt32LE(6 + 16, 12); // offset

  return Buffer.concat([iconDir, entry, pngBuf]);
}

const pixels = buildPixels();
const png = buildPng(pixels);
const ico = buildIco(png);

const outDir = path.join(__dirname, "..", "assets");
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "tray-icon.ico"), ico);
console.log(`Wrote ${path.join(outDir, "tray-icon.ico")} (${ico.length} bytes)`);
