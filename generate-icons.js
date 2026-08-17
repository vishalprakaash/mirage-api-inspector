/**
 * Generates Mirage extension PNG icons without any external dependencies.
 * Usage: node generate-icons.js
 * Outputs: icons/icon16.png, icons/icon48.png, icons/icon128.png
 */

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CRC32 ────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return ((crc ^ 0xffffffff) >>> 0);
}

// ─── PNG writer ───────────────────────────────────────────────────────────────

function writeUInt32BE(n) {
  return Buffer.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = writeUInt32BE(data.length);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crcBytes = writeUInt32BE(crc32(crcInput));
  return Buffer.concat([len, typeBytes, data, crcBytes]);
}

function makePNG(width, height, drawFn) {
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Build raw RGBA rows
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = drawFn(x, y, width, height);
      row[1 + x * 4] = r;
      row[2 + x * 4] = g;
      row[3 + x * 4] = b;
      row[4 + x * 4] = a ?? 255;
    }
    rows.push(row);
  }

  const rawData = Buffer.concat(rows);
  const compressed = zlib.deflateSync(rawData, { level: 9 });

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

// ─── Mirage icon drawing ──────────────────────────────────────────────────────

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / lenSq, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function drawMirageIcon(x, y, w, h) {
  const cx = w / 2, cy = h / 2, r = w / 2;
  const px = x + 0.5, py = y + 0.5;

  // Distance from centre (for circle mask)
  const distFromCenter = Math.hypot(px - cx, py - cy);
  if (distFromCenter > r - 0.5) return [0, 0, 0, 0]; // transparent outside

  // Background gradient (purple → indigo)
  const t = clamp(Math.hypot(px - 0, py - 0) / (w * 1.4), 0, 1);
  const bgR = Math.round(lerp(0x7c, 0x4f, t));
  const bgG = Math.round(lerp(0x3a, 0x46, t));
  const bgB = Math.round(lerp(0xed, 0xe5, t));

  // Circle alpha (anti-aliased edge)
  const alpha = clamp((r - distFromCenter) * 2, 0, 1);

  // Wave path: Q(w*0.25, h*0.35) Q(w*0.5, h*0.55) Q(w*0.75, h*0.35) to (w*0.88, h*0.35)
  const segments = [
    [w * 0.12, h * 0.55, w * 0.25, h * 0.38, w * 0.38, h * 0.55],
    [w * 0.38, h * 0.55, w * 0.50, h * 0.38, w * 0.62, h * 0.55],
    [w * 0.62, h * 0.55, w * 0.75, h * 0.38, w * 0.88, h * 0.55],
  ];

  const strokeWidth = Math.max(1.2, w * 0.065);
  let minDist = Infinity;

  for (const [x0, y0, x1, y1, x2, y2] of segments) {
    // Approximate quadratic bezier with line segments
    const steps = 20;
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps, t1 = (i + 1) / steps;
      const bt0x = (1 - t0) * (1 - t0) * x0 + 2 * (1 - t0) * t0 * x1 + t0 * t0 * x2;
      const bt0y = (1 - t0) * (1 - t0) * y0 + 2 * (1 - t0) * t0 * y1 + t0 * t0 * y2;
      const bt1x = (1 - t1) * (1 - t1) * x0 + 2 * (1 - t1) * t1 * x1 + t1 * t1 * x2;
      const bt1y = (1 - t1) * (1 - t1) * y0 + 2 * (1 - t1) * t1 * y1 + t1 * t1 * y2;
      minDist = Math.min(minDist, distToSegment(px, py, bt0x, bt0y, bt1x, bt1y));
    }
  }

  const waveAlpha = clamp(strokeWidth / 2 - minDist + 1, 0, 1);

  const outR = Math.round(lerp(bgR, 255, waveAlpha));
  const outG = Math.round(lerp(bgG, 255, waveAlpha));
  const outB = Math.round(lerp(bgB, 255, waveAlpha));

  return [outR, outG, outB, Math.round(alpha * 255)];
}

// ─── Generate ─────────────────────────────────────────────────────────────────

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir);

for (const size of [16, 48, 128]) {
  const png = makePNG(size, size, drawMirageIcon);
  const outPath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`✓ icons/icon${size}.png  (${png.length} bytes)`);
}

console.log('\nDone! Icons written to icons/');
