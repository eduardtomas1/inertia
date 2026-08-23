import { open } from "node:fs/promises";

export const NATIVE_HEADER_READ_LIMIT = 4 * 1024;

const ARCHITECTURES = new Set(["x64", "arm64"]);
const MACH_O_64_MAGICS = new Map([
  ["cffaedfe", "little"],
  ["feedfacf", "big"],
]);
const MACH_O_FAT_MAGICS = new Set([
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca",
]);
const MACH_O_CPU_TYPES = new Map([
  [0x01000007, "x64"],
  [0x0100000c, "arm64"],
]);
const PE_MACHINE_TYPES = new Map([
  [0x8664, "x64"],
  [0xaa64, "arm64"],
]);
const ELF_MACHINE_TYPES = new Map([
  [0x003e, "x64"],
  [0x00b7, "arm64"],
]);

function requireBytes(header, count, format) {
  if (!Buffer.isBuffer(header) || header.length < count) {
    throw new Error(`The Claude SDK ${format} executable header is truncated.`);
  }
}

function parseMachOArchitecture(header) {
  requireBytes(header, 4, "Mach-O");
  const magic = header.subarray(0, 4).toString("hex");
  if (MACH_O_FAT_MAGICS.has(magic)) {
    throw new Error("The Claude SDK executable uses a universal/fat Mach-O header; a thin architecture is required.");
  }
  requireBytes(header, 32, "Mach-O");
  const byteOrder = MACH_O_64_MAGICS.get(magic);
  if (!byteOrder) {
    throw new Error("The Claude SDK executable is not a supported 64-bit Mach-O binary.");
  }
  const cpuType = byteOrder === "little"
    ? header.readUInt32LE(4)
    : header.readUInt32BE(4);
  const architecture = MACH_O_CPU_TYPES.get(cpuType);
  if (!architecture) {
    throw new Error(`The Claude SDK Mach-O CPU type 0x${cpuType.toString(16)} is unsupported.`);
  }
  return architecture;
}

function parsePeArchitecture(header) {
  requireBytes(header, 64, "PE");
  if (header[0] !== 0x4d || header[1] !== 0x5a) {
    throw new Error("The Claude SDK executable does not have an MZ header.");
  }
  const peOffset = header.readUInt32LE(0x3c);
  if (peOffset < 64 || peOffset > NATIVE_HEADER_READ_LIMIT - 6) {
    throw new Error("The Claude SDK PE header offset is outside the bounded executable prefix.");
  }
  requireBytes(header, peOffset + 6, "PE");
  if (!header.subarray(peOffset, peOffset + 4).equals(Buffer.from("PE\0\0", "binary"))) {
    throw new Error("The Claude SDK executable does not have a valid PE signature.");
  }
  const machine = header.readUInt16LE(peOffset + 4);
  const architecture = PE_MACHINE_TYPES.get(machine);
  if (!architecture) {
    throw new Error(`The Claude SDK PE machine type 0x${machine.toString(16)} is unsupported.`);
  }
  return architecture;
}

function parseElfArchitecture(header) {
  requireBytes(header, 64, "ELF");
  if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error("The Claude SDK executable does not have an ELF header.");
  }
  if (header[4] !== 2 || header[5] !== 1 || header[6] !== 1) {
    throw new Error("The Claude SDK executable is not a supported 64-bit little-endian ELF binary.");
  }
  const machine = header.readUInt16LE(18);
  const architecture = ELF_MACHINE_TYPES.get(machine);
  if (!architecture) {
    throw new Error(`The Claude SDK ELF machine type 0x${machine.toString(16)} is unsupported.`);
  }
  return architecture;
}

export function parseNativeBinaryArchitecture(header, platform) {
  if (platform === "darwin") return parseMachOArchitecture(header);
  if (platform === "win32") return parsePeArchitecture(header);
  if (platform === "linux") return parseElfArchitecture(header);
  throw new Error(`Unsupported native binary platform: ${platform}.`);
}

export async function inspectNativeBinaryArchitecture(
  filePath,
  options = {},
) {
  const platform = options.platform ?? process.platform;
  const expectedArchitecture = options.expectedArchitecture ?? process.arch;
  if (!ARCHITECTURES.has(expectedArchitecture)) {
    throw new Error(`Unsupported expected native architecture: ${expectedArchitecture}.`);
  }
  const openFile = options.openFile ?? open;
  const handle = await openFile(filePath, "r");
  try {
    const header = Buffer.alloc(NATIVE_HEADER_READ_LIMIT);
    const { bytesRead } = await handle.read(
      header,
      0,
      NATIVE_HEADER_READ_LIMIT,
      0,
    );
    const architecture = parseNativeBinaryArchitecture(
      header.subarray(0, bytesRead),
      platform,
    );
    if (architecture !== expectedArchitecture) {
      throw new Error(
        `Claude SDK native architecture mismatch: expected ${expectedArchitecture}, found ${architecture}.`,
      );
    }
    return architecture;
  } finally {
    await handle.close();
  }
}
