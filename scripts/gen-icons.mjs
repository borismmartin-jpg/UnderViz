// Generates the PWA icons (public/icons/icon-*.png) with zero dependencies —
// draws an ocean-swell motif into an RGBA buffer and encodes a valid PNG using
// node:zlib. Re-run with:  node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

// ---- minimal PNG encoder (8-bit RGBA, no interlace) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  // scanlines, each prefixed with filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- icon artwork: dark water gradient + three swell lines ----
function drawIcon(S) {
  const px = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) {
    const t = y / S; // surface -> depth gradient
    const r = Math.round(14 - 7 * t), g = Math.round(33 - 16 * t), b = Math.round(56 - 24 * t);
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
  }
  const waves = [
    { yc: 0.32, a: 1.0 },  // bright surface swell
    { yc: 0.54, a: 0.6 },  // dimmer with depth ...
    { yc: 0.76, a: 0.32 }, // ... like visibility fading
  ];
  const amp = 0.055 * S, th = 0.05 * S, wl = S / 1.35;
  for (const w of waves) {
    for (let x = 0; x < S; x++) {
      const yc = w.yc * S + amp * Math.sin((2 * Math.PI * x) / wl + w.yc * 9);
      for (let y = Math.floor(yc - th); y <= Math.ceil(yc + th); y++) {
        if (y < 0 || y >= S) continue;
        const dist = Math.abs(y - yc);
        if (dist > th) continue;
        const alpha = w.a * Math.min(1, (th - dist) / (0.35 * th)); // soft edges
        const i = (y * S + x) * 4;
        px[i] = Math.round(px[i] * (1 - alpha) + 0x37 * alpha);
        px[i + 1] = Math.round(px[i + 1] * (1 - alpha) + 0xc8 * alpha);
        px[i + 2] = Math.round(px[i + 2] * (1 - alpha) + 0xf0 * alpha);
      }
    }
  }
  return px;
}

for (const size of [180, 192, 512]) {
  const file = path.join(outDir, `icon-${size}.png`);
  writeFileSync(file, encodePng(size, drawIcon(size)));
  console.log('wrote', file);
}
