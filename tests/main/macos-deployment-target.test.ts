import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const roots: string[] = [];
const run = promisify(execFile);
async function verifier() {
  return await import(pathToFileURL(join(repositoryRoot, "scripts/native-binary-architecture.mjs")).href) as {
    verifyMacosDeploymentTarget: (file: string, target: string, architecture?: string) => void;
  };
}
async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "inertia-macos-target-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function machO(minimum: number, architecture: "x64" | "arm64" = "arm64", legacy = false, bigEndian = false) {
  const size = legacy ? 16 : 24;
  const bytes = Buffer.alloc(32 + size);
  const write = (value: number, offset: number) => bigEndian
    ? bytes.writeUInt32BE(value, offset) : bytes.writeUInt32LE(value, offset);
  write(0xfeedfacf, 0);
  write(architecture === "arm64" ? 0x0100000c : 0x01000007, 4);
  write(2, 12); // MH_EXECUTE
  write(1, 16);
  write(size, 20);
  write(legacy ? 0x24 : 0x32, 32);
  write(size, 36);
  if (!legacy) write(1, 40); // PLATFORM_MACOS
  write(minimum, legacy ? 40 : 44);
  return bytes;
}
async function binary(bytes: Buffer) {
  const file = join(await temporaryRoot(), "guardian");
  await writeFile(file, bytes, { mode: 0o755 });
  return file;
}

it.each(["arm64", "x64"] as const)("checks actual %s load-command bytes in both macOS version formats", async (architecture) => {
  const { verifyMacosDeploymentTarget } = await verifier();
  for (const legacy of [false, true]) {
    for (const bigEndian of [false, true]) {
      const file = await binary(machO(13 * 65536, architecture, legacy, bigEndian));
      expect(() => verifyMacosDeploymentTarget(file, "13.0", architecture)).not.toThrow();
      expect(() => verifyMacosDeploymentTarget(file, "12.6", architecture)).toThrow("newer than the declared 12.6");
    }
  }
});

it("rejects newer minor/patch requirements and a foreign architecture", async () => {
  const { verifyMacosDeploymentTarget } = await verifier();
  for (const minimum of [13 * 65536 + 1, 13 * 65536 + 256, 15 * 65536]) {
    const file = await binary(machO(minimum));
    expect(() => verifyMacosDeploymentTarget(file, "13.0", "arm64")).toThrow("newer than the declared 13.0");
  }
  const file = await binary(machO(13 * 65536));
  expect(() => verifyMacosDeploymentTarget(file, "13.0", "x64")).toThrow("architecture mismatch");
  for (const invalid of ["", "13", "13.256", "0.0", "65536.0"]) {
    expect(() => verifyMacosDeploymentTarget(file, invalid, "arm64")).toThrow("deployment target is invalid");
  }
});

it.each([
  ["truncated", (bytes: Buffer) => bytes.subarray(0, 31)],
  ["missing", (bytes: Buffer) => { bytes.writeUInt32LE(0, 16); bytes.writeUInt32LE(0, 20); return bytes; }],
  ["oversized command region", (bytes: Buffer) => { bytes.writeUInt32LE(65536, 20); return bytes; }],
  ["short command", (bytes: Buffer) => { bytes.writeUInt32LE(8, 36); return bytes; }],
  ["non-macOS platform", (bytes: Buffer) => { bytes.writeUInt32LE(2, 40); return bytes; }],
  ["missing tool records", (bytes: Buffer) => { bytes.writeUInt32LE(1, 52); return bytes; }],
  ["duplicate versions", (bytes: Buffer) => {
    const duplicate = Buffer.concat([bytes, bytes.subarray(32)]);
    duplicate.writeUInt32LE(2, 16); duplicate.writeUInt32LE(48, 20); return duplicate;
  }],
] as const)("rejects %s deployment metadata", async (_name, change) => {
  const { verifyMacosDeploymentTarget } = await verifier();
  const file = await binary(change(machO(13 * 65536)));
  expect(() => verifyMacosDeploymentTarget(file, "13.0", "arm64")).toThrow();
});

it.skipIf(process.platform !== "darwin")("builds the real guardian for the declared macOS minimum despite a newer host target", async () => {
  const root = await temporaryRoot();
  const output = join(root, "generated/runtime-process-guardian");
  await run(process.execPath, [join(repositoryRoot, "scripts/build-runtime-process-guardian.mjs")], {
    cwd: repositoryRoot,
    env: {
      ...process.env, NODE_ENV: "test", MACOSX_DEPLOYMENT_TARGET: "26.0",
      INERTIA_TEST_GUARDIAN_COMPILER: "",
      INERTIA_TEST_GUARDIAN_OUTPUT_DIRECTORY: output,
    },
    timeout: 30_000, maxBuffer: 64 * 1024,
  });
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
    build: { mac: { minimumSystemVersion: string } };
  };
  const { verifyMacosDeploymentTarget } = await verifier();
  expect(() => verifyMacosDeploymentTarget(
    join(output, "runtime-process-guardian"), manifest.build.mac.minimumSystemVersion,
  )).not.toThrow();
});

it.skipIf(process.platform !== "darwin")("package smoke rejects a newer guardian before parsing the archive or launching the app", async () => {
  const root = await temporaryRoot();
  const resources = join(root, "resources");
  const files = {
    "THIRD_PARTY_NOTICES.txt": "INERTIA THIRD-PARTY NOTICES\nPACKAGES\nVENDORED COMPONENT LICENSE AND NOTICE TEXTS\nPACKAGE LICENSE AND NOTICE TEXTS",
    "LICENSE.txt": "Apache License\nVersion 2.0, January 2004\nEND OF TERMS AND CONDITIONS",
    "electron/LICENSE.txt": 'Copyright Electron contributors\nPermission is hereby granted, free of charge\nTHE SOFTWARE IS PROVIDED "AS IS"',
    "electron/LICENSES.chromium.html": '<html><title>Credits</title><div class="license"><pre>Copyright fixture</pre></div></html>',
    "app.asar": "Archive parsing must not happen.",
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(resources, name)), { recursive: true });
    await writeFile(join(resources, name), content);
  }
  await mkdir(join(resources, "runtime"));
  await writeFile(join(resources, "runtime/runtime-process-guardian"), machO(26 * 65536, process.arch as "arm64" | "x64"), { mode: 0o755 });
  const executable = join(root, "Inertia");
  await writeFile(executable, "This fixture must never be executed.", { mode: 0o755 });
  const result = await run(process.execPath, [join(repositoryRoot, "scripts/package-smoke.mjs")], {
    cwd: root,
    env: {
      PATH: process.env.PATH, INERTIA_PACKAGE_SMOKE_EXECUTABLE: executable,
      INERTIA_PACKAGE_SMOKE_RESOURCES: resources,
    },
    timeout: 5_000, maxBuffer: 32 * 1024,
  }).then(() => ({ code: 0, stderr: "" }), (error: unknown) => error as { code: number; stderr: string });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("requires macOS 26.0.0, newer than the declared 13.0 minimum");
});
