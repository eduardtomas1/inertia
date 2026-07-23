import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");
const EXPECTED_FUSES = [
  ["RunAsNode", false],
  ["EnableCookieEncryption", true],
  ["EnableNodeOptionsEnvironmentVariable", false],
  ["EnableNodeCliInspectArguments", false],
  ["EnableEmbeddedAsarIntegrityValidation", true],
  ["OnlyLoadAppFromAsar", true],
  ["LoadBrowserProcessSpecificV8Snapshot", false],
  ["GrantFileProtocolExtraPrivileges", false],
  ["WasmTrapHandlers", true],
];

function fuseBinaryPath(applicationPath, applicationStat) {
  if (!applicationStat.isDirectory()) return applicationPath;
  if (!applicationPath.endsWith(".app")) {
    throw new Error("A packaged application directory must be a macOS .app bundle.");
  }
  return join(
    applicationPath,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
    "Electron Framework",
  );
}

function stateLabel(value) {
  if (value === 0x30) return "disabled";
  if (value === 0x31) return "enabled";
  if (value === 0x72) return "removed";
  return `invalid-0x${value.toString(16).padStart(2, "0")}`;
}

const requestedPath = process.argv[2];
if (!requestedPath) {
  throw new Error("Usage: npm run verify:fuses -- <packaged executable or macOS .app>");
}

const applicationPath = resolve(requestedPath);
const binaryPath = fuseBinaryPath(applicationPath, await stat(applicationPath));
const binary = await readFile(binaryPath);
const wires = [];
let searchFrom = 0;

while (searchFrom < binary.length) {
  const sentinelOffset = binary.indexOf(SENTINEL, searchFrom);
  if (sentinelOffset < 0) break;
  const headerOffset = sentinelOffset + SENTINEL.length;
  const version = binary[headerOffset];
  const length = binary[headerOffset + 1];
  if (version !== 1) throw new Error(`Unsupported Electron fuse schema v${version}.`);
  if (length !== EXPECTED_FUSES.length) {
    throw new Error(`Electron fuse schema has ${length} entries; expected exactly ${EXPECTED_FUSES.length}. Update the verifier before packaging.`);
  }

  const states = EXPECTED_FUSES.map(([name, enabled], index) => {
    const actual = binary[headerOffset + 2 + index];
    const expected = enabled ? 0x31 : 0x30;
    if (actual !== expected) {
      throw new Error(`${name} is ${stateLabel(actual)}; expected ${stateLabel(expected)}.`);
    }
    return { name, state: stateLabel(actual) };
  });
  wires.push({ sentinelOffset, version, states });
  searchFrom = headerOffset + 2 + length;
}

if (wires.length === 0) throw new Error("The Electron fuse sentinel was not found in the packaged binary.");

console.log(JSON.stringify({
  application: applicationPath,
  binary: binaryPath,
  fuseVersion: 1,
  wires,
}, null, 2));
