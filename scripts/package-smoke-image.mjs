import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let checksum = 0xffff_ffff;
  for (const byte of body) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum & 1) === 1
        ? 0xedb8_8320 ^ (checksum >>> 1)
        : checksum >>> 1;
    }
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((checksum ^ 0xffff_ffff) >>> 0);
  return Buffer.concat([length, body, crc]);
}

export function packageSmokeImageBytes() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(4, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6; // Four RGBA pixels, with the default PNG filter/compression.
  // Fresh pixel bytes prevent a candidate's ordinary fixture from matching
  // its predecessor's historical attachment during recovery smoke tests.
  const scanline = Buffer.concat([Buffer.from([0]), randomBytes(16)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanline)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
