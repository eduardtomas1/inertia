import { crc32, deflateSync } from "node:zlib";

export function pngChunk(kind: string, data = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length);
  header.write(kind, 4, "ascii");
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])));
  return Buffer.concat([header, data, checksum]);
}

export function withEmptyPngDataChunks(png: Buffer): Buffer {
  const chunks = [png.subarray(0, 8)];
  for (let offset = 8; offset < png.length;) {
    const end = offset + png.readUInt32BE(offset) + 12;
    const chunk = png.subarray(offset, end);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      chunks.push(pngChunk("IDAT"), chunk, pngChunk("IDAT"));
    } else chunks.push(chunk);
    offset = end;
  }
  return Buffer.concat(chunks);
}

/** A CRC-valid indexed PNG whose dimensions are readable, but its palette is missing. */
export function pngWithoutPalette(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 3;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", Buffer.from(deflateSync(Buffer.alloc(6)))),
    pngChunk("IEND"),
  ]);
}
