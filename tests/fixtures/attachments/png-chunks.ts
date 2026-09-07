import { crc32 } from "node:zlib";

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
