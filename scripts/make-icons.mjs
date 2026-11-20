#!/usr/bin/env node
/**
 * Generates the extension PNG icons without any image dependencies.
 * Run: node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'icons');

const BG_TOP = [28, 34, 29];
const BG_BOTTOM = [17, 21, 18];
const LIME = [200, 244, 90];
const PAPER = [242, 245, 238];
const BORDER = [48, 57, 50];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function roundedRectDistance(x, y, size, radius) {
  const half = size / 2;
  const qx = Math.abs(x - half) - (half - radius);
  const qy = Math.abs(y - half) - (half - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function drawIcon(size) {
  const scale = 4;
  const S = size * scale;
  const radius = S * 0.235;
  const u = S / 128;
  const buffer = Buffer.alloc(S * S * 4);

  const topShaft = (x, y) => x >= 34 * u && x <= 88 * u && Math.abs(y - 49 * u) <= 4 * u;
  const topHead = (x, y) =>
    pointInTriangle(x, y, 84 * u, 35 * u, 84 * u, 63 * u, 108 * u, 49 * u);
  const bottomShaft = (x, y) => x >= 40 * u && x <= 94 * u && Math.abs(y - 79 * u) <= 4 * u;
  const bottomHead = (x, y) =>
    pointInTriangle(x, y, 44 * u, 65 * u, 44 * u, 93 * u, 20 * u, 79 * u);

  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      const i = (y * S + x) * 4;
      const px = x + 0.5;
      const py = y + 0.5;
      const distance = roundedRectDistance(px, py, S, radius);
      if (distance > 0) {
        buffer[i + 3] = 0;
        continue;
      }
      let color;
      if (topHead(px, py) || topShaft(px, py)) color = LIME;
      else if (bottomHead(px, py) || bottomShaft(px, py)) color = PAPER;
      else if (distance > -1.6 * scale) color = BORDER;
      else {
        const t = y / S;
        color = BG_TOP.map((channel, index) => Math.round(channel + (BG_BOTTOM[index] - channel) * t));
      }
      buffer[i] = color[0];
      buffer[i + 1] = color[1];
      buffer[i + 2] = color[2];
      buffer[i + 3] = 255;
    }
  }

  // Downsample with premultiplied alpha for clean rounded corners.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const i = ((y * scale + sy) * S + (x * scale + sx)) * 4;
          const alpha = buffer[i + 3] / 255;
          r += buffer[i] * alpha;
          g += buffer[i + 1] * alpha;
          b += buffer[i + 2] * alpha;
          a += alpha;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round((a / (scale * scale)) * 255);
      }
    }
  }
  return encodePng(size, size, out);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = resolve(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, drawIcon(size));
  console.log(`wrote ${file}`);
}
