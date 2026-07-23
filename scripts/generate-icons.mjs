import { deflateSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SOURCE_PATH = join(ROOT, "resources", "icon.svg");
const ICON_DIRECTORY = join(ROOT, "resources", "icons");
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const EXPECTED_SOURCE_MARKERS = [
  'viewBox="0 0 1024 1024"',
  'fill="#07070a"',
  "M384 521",
  "m520 184",
];

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1) current = (current & 1) ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  return current >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const outputOffset = y * (width * 4 + 1);
    scanlines[outputOffset] = 0;
    rgba.copy(scanlines, outputOffset + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function distanceToSegment(x, y, startX, startY, endX, endY) {
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  const position = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - startX) * deltaX + (y - startY) * deltaY) / lengthSquared));
  return Math.hypot(x - (startX + position * deltaX), y - (startY + position * deltaY));
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
    const currentPoint = points[index];
    const previousPoint = points[previous];
    if ((currentPoint[1] > y) !== (previousPoint[1] > y)
      && x < ((previousPoint[0] - currentPoint[0]) * (y - currentPoint[1])) / (previousPoint[1] - currentPoint[1]) + currentPoint[0]) inside = !inside;
  }
  return inside;
}

function inRoundedSquare(x, y) {
  const radius = 168;
  const innerX = Math.max(radius, Math.min(1024 - radius, x));
  const innerY = Math.max(radius, Math.min(1024 - radius, y));
  return Math.hypot(x - innerX, y - innerY) <= radius;
}

const shoulder = [[384, 521], [446, 459], [591, 459], [641, 521], [737, 521]];
const body = [
  [[530, 485], [460, 703], [301, 703]],
  [[525, 540], [606, 631], [645, 784]],
];
const cursor = [[520, 184], [706, 307], [637, 329], [686, 402], [629, 440], [580, 364], [535, 415]];

function isWhiteMark(x, y) {
  for (let index = 1; index < shoulder.length; index += 1) {
    if (distanceToSegment(x, y, ...shoulder[index - 1], ...shoulder[index]) <= 33) return true;
  }
  for (const stroke of body) {
    for (let index = 1; index < stroke.length; index += 1) {
      if (distanceToSegment(x, y, ...stroke[index - 1], ...stroke[index]) <= 36) return true;
    }
  }
  if (pointInPolygon(x, y, cursor)) return true;
  for (let index = 0; index < cursor.length; index += 1) {
    if (distanceToSegment(x, y, ...cursor[index], ...cursor[(index + 1) % cursor.length]) <= 6.5) return true;
  }
  return false;
}

function renderIcon(size) {
  const samples = size >= 512 ? 2 : 4;
  const output = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let backgroundCoverage = 0;
      let markCoverage = 0;
      for (let sampleY = 0; sampleY < samples; sampleY += 1) {
        for (let sampleX = 0; sampleX < samples; sampleX += 1) {
          const sourceX = ((x + (sampleX + 0.5) / samples) / size) * 1024;
          const sourceY = ((y + (sampleY + 0.5) / samples) / size) * 1024;
          if (!inRoundedSquare(sourceX, sourceY)) continue;
          backgroundCoverage += 1;
          if (isWhiteMark(sourceX, sourceY)) markCoverage += 1;
        }
      }
      const totalSamples = samples * samples;
      const offset = (y * size + x) * 4;
      const alpha = Math.round((backgroundCoverage / totalSamples) * 255);
      const mix = backgroundCoverage === 0 ? 0 : markCoverage / backgroundCoverage;
      const dark = 8;
      const light = 255;
      const value = Math.round(dark + (light - dark) * mix);
      output[offset] = value;
      output[offset + 1] = value;
      output[offset + 2] = Math.round(value + (1 - mix) * 2);
      output[offset + 3] = alpha;
    }
  }
  return encodePng(size, size, output);
}

const source = await readFile(SOURCE_PATH, "utf8");
for (const marker of EXPECTED_SOURCE_MARKERS) {
  if (!source.includes(marker)) throw new Error(`The icon source is not the expected Inertia mark (${marker}).`);
}

await mkdir(ICON_DIRECTORY, { recursive: true });
for (const size of SIZES) {
  const outputPath = join(ICON_DIRECTORY, `${size}x${size}.png`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderIcon(size), { mode: 0o644 });
}
await writeFile(join(ROOT, "resources", "icon.png"), renderIcon(1024), { mode: 0o644 });
console.log(`Generated ${SIZES.length} Linux icons and the cross-platform 1024px icon from resources/icon.svg.`);
