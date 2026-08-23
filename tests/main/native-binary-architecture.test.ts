import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const moduleUrl = pathToFileURL(join(root, "scripts", "native-binary-architecture.mjs")).href;

async function architectureModule() {
  return await import(moduleUrl) as {
    NATIVE_HEADER_READ_LIMIT: number;
    inspectNativeBinaryArchitecture: (
      filePath: string,
      options: {
        expectedArchitecture: "arm64" | "x64";
        openFile: () => Promise<{
          close: () => Promise<void>;
          read: (
            buffer: Buffer,
            offset: number,
            length: number,
            position: number,
          ) => Promise<{ buffer: Buffer; bytesRead: number }>;
        }>;
        platform: NodeJS.Platform;
      },
    ) => Promise<"arm64" | "x64">;
    parseNativeBinaryArchitecture: (
      header: Buffer,
      platform: NodeJS.Platform,
    ) => "arm64" | "x64";
  };
}

function machOHeader(architecture: "arm64" | "x64", byteOrder: "big" | "little" = "little") {
  const header = Buffer.alloc(32);
  if (byteOrder === "little") {
    Buffer.from("cffaedfe", "hex").copy(header);
    header.writeUInt32LE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4);
  } else {
    Buffer.from("feedfacf", "hex").copy(header);
    header.writeUInt32BE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4);
  }
  return header;
}

function peHeader(architecture: "arm64" | "x64", peOffset = 0x80) {
  const header = Buffer.alloc(4 * 1024);
  header.write("MZ", 0, "ascii");
  header.writeUInt32LE(peOffset, 0x3c);
  if (peOffset <= header.length - 6) {
    header.write("PE\0\0", peOffset, "binary");
    header.writeUInt16LE(architecture === "arm64" ? 0xaa64 : 0x8664, peOffset + 4);
  }
  return header;
}

function elfHeader(architecture: "arm64" | "x64") {
  const header = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(header);
  header[4] = 2;
  header[5] = 1;
  header[6] = 1;
  header.writeUInt16LE(architecture === "arm64" ? 0x00b7 : 0x003e, 18);
  return header;
}

test("parses thin 64-bit Mach-O CPU types and rejects universal binaries", async () => {
  const { parseNativeBinaryArchitecture } = await architectureModule();

  expect(parseNativeBinaryArchitecture(machOHeader("x64"), "darwin")).toBe("x64");
  expect(parseNativeBinaryArchitecture(machOHeader("arm64", "big"), "darwin")).toBe("arm64");
  expect(() => parseNativeBinaryArchitecture(
    Buffer.from("cafebabe00000002", "hex"),
    "darwin",
  )).toThrow("universal/fat Mach-O");
  expect(() => parseNativeBinaryArchitecture(
    Buffer.alloc(7),
    "darwin",
  )).toThrow("header is truncated");
});

test("parses PE machine types at a bounded DOS header offset", async () => {
  const { NATIVE_HEADER_READ_LIMIT, parseNativeBinaryArchitecture } = await architectureModule();

  expect(parseNativeBinaryArchitecture(peHeader("x64", 0x180), "win32")).toBe("x64");
  expect(parseNativeBinaryArchitecture(peHeader("arm64"), "win32")).toBe("arm64");

  const truncated = peHeader("x64", 0x180).subarray(0, 0x100);
  expect(() => parseNativeBinaryArchitecture(truncated, "win32")).toThrow(
    "header is truncated",
  );
  expect(() => parseNativeBinaryArchitecture(
    peHeader("x64", NATIVE_HEADER_READ_LIMIT - 5),
    "win32",
  )).toThrow("outside the bounded executable prefix");

  const invalidSignature = peHeader("x64");
  invalidSignature.fill(0, 0x80, 0x84);
  expect(() => parseNativeBinaryArchitecture(invalidSignature, "win32")).toThrow(
    "valid PE signature",
  );
});

test("requires 64-bit little-endian ELF machine headers", async () => {
  const { parseNativeBinaryArchitecture } = await architectureModule();

  expect(parseNativeBinaryArchitecture(elfHeader("x64"), "linux")).toBe("x64");
  expect(parseNativeBinaryArchitecture(elfHeader("arm64"), "linux")).toBe("arm64");

  const bigEndian = elfHeader("arm64");
  bigEndian[5] = 2;
  expect(() => parseNativeBinaryArchitecture(bigEndian, "linux")).toThrow(
    "64-bit little-endian ELF",
  );
  expect(() => parseNativeBinaryArchitecture(Buffer.alloc(20), "linux")).toThrow(
    "header is truncated",
  );
});

test("rejects a valid header for the wrong expected architecture", async () => {
  const { inspectNativeBinaryArchitecture } = await architectureModule();
  const header = elfHeader("x64");
  let closed = false;

  await expect(inspectNativeBinaryArchitecture("unused", {
    expectedArchitecture: "arm64",
    openFile: async () => ({
      close: async () => { closed = true; },
      read: async (buffer) => {
        header.copy(buffer);
        return { buffer, bytesRead: header.length };
      },
    }),
    platform: "linux",
  })).rejects.toThrow("expected arm64, found x64");
  expect(closed).toBe(true);
});

test("reads only the fixed executable prefix and closes the file", async () => {
  const {
    inspectNativeBinaryArchitecture,
    NATIVE_HEADER_READ_LIMIT,
  } = await architectureModule();
  const header = elfHeader("arm64");
  let closed = false;
  let requestedRead: [number, number, number] | undefined;

  await expect(inspectNativeBinaryArchitecture("unused", {
    expectedArchitecture: "arm64",
    openFile: async () => ({
      close: async () => { closed = true; },
      read: async (buffer, offset, length, position) => {
        requestedRead = [offset, length, position];
        header.copy(buffer);
        return { buffer, bytesRead: header.length };
      },
    }),
    platform: "linux",
  })).resolves.toBe("arm64");
  expect(requestedRead).toEqual([0, NATIVE_HEADER_READ_LIMIT, 0]);
  expect(closed).toBe(true);
});
