import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
const electronLicense = `Copyright (c) Electron contributors
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.`;
const legalFiles = {
  "THIRD_PARTY_NOTICES.txt": `INERTIA THIRD-PARTY NOTICES
PACKAGES
VENDORED COMPONENT LICENSE AND NOTICE TEXTS
PACKAGE LICENSE AND NOTICE TEXTS
Copyright fixture contributors`,
  "LICENSE.txt": "Apache License\nVersion 2.0, January 2004\nEND OF TERMS AND CONDITIONS",
  "electron/LICENSE.txt": electronLicense,
  "electron/LICENSES.chromium.html": `<!doctype html><html><head><title>Credits</title></head>
<body><div class="license"><pre>${electronLicense}</pre></div>`,
};
type LegalPath = keyof typeof legalFiles;

async function verifier() {
  return await import(pathToFileURL(resolve("scripts/package-smoke-legal-resources.mjs")).href) as {
    verifyPackagedLegalResources: (directory: string) => Promise<Array<{
      path: string; bytes: number; sha256: string;
    }>>;
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inertia-package-legal-"));
  roots.push(root);
  const resources = join(root, "package resources");
  for (const [name, content] of Object.entries(legalFiles)) {
    const path = join(resources, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return { root, resources };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("rejects missing packaged Electron licenses before any native smoke launch", async () => {
  const { root, resources } = await fixture();
  await rm(join(resources, "electron"), { recursive: true });
  const executable = join(root, process.platform === "win32" ? "Inertia.exe" : "inertia");
  await writeFile(executable, "This fixture must never be executed.", { mode: 0o700 });
  await writeFile(join(resources, "app.asar"), "Archive parsing must happen after legal verification.");
  const result = await promisify(execFile)(process.execPath, [resolve("scripts/package-smoke.mjs")], {
    cwd: root,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      INERTIA_PACKAGE_SMOKE_EXECUTABLE: executable,
      INERTIA_PACKAGE_SMOKE_RESOURCES: resources,
    },
    timeout: 5_000,
    maxBuffer: 32 * 1024,
  }).then(
    () => ({ code: 0, stderr: "" }),
    (error: unknown) => error as { code: number; stderr: string },
  );
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("packaged legal resource electron/LICENSE.txt");
  expect(result.stderr).not.toContain("Archive parsing must happen");
});

it("verifies all four artifact-only resources and reports hashes of their actual bytes", async () => {
  const { resources } = await fixture();
  const { verifyPackagedLegalResources } = await verifier();
  expect(await verifyPackagedLegalResources(resources)).toEqual(
    Object.entries(legalFiles).map(([path, content]) => ({
      path, bytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    })),
  );
});

it.each(Object.keys(legalFiles) as LegalPath[])("rejects absent, empty and wrong-content %s", async (name) => {
  const { resources } = await fixture();
  const { verifyPackagedLegalResources } = await verifier();
  const path = join(resources, name);
  await rm(path);
  await expect(verifyPackagedLegalResources(resources)).rejects.toThrow(`legal resource ${name}`);
  for (const content of ["", "packaging warning: source file missing", legalFiles[name].slice(0, 24)]) {
    await writeFile(path, content);
    await expect(verifyPackagedLegalResources(resources)).rejects.toThrow(`legal resource ${name}`);
  }
});

it.each([
  ["THIRD_PARTY_NOTICES.txt", 16 * 1024 * 1024],
  ["LICENSE.txt", 64 * 1024],
  ["electron/LICENSE.txt", 64 * 1024],
  ["electron/LICENSES.chromium.html", 64 * 1024 * 1024],
] as const)("rejects oversized %s without reading the sparse payload", async (name, maximumBytes) => {
  const { resources } = await fixture();
  await truncate(join(resources, name), maximumBytes + 1);
  const { verifyPackagedLegalResources } = await verifier();
  await expect(verifyPackagedLegalResources(resources)).rejects.toThrow(`legal resource ${name}`);
});

it("rejects nonregular resources and malformed text instead of accepting presence alone", async () => {
  const { resources } = await fixture();
  const path = join(resources, "LICENSE.txt");
  const { verifyPackagedLegalResources } = await verifier();
  await rm(path);
  await mkdir(path);
  await expect(verifyPackagedLegalResources(resources)).rejects.toThrow("legal resource LICENSE.txt");
  await rm(path, { recursive: true });
  for (const suffix of [Buffer.from([0xff]), Buffer.from([0])]) {
    await writeFile(path, Buffer.concat([Buffer.from(legalFiles["LICENSE.txt"]), suffix]));
    await expect(verifyPackagedLegalResources(resources)).rejects.toThrow("legal resource LICENSE.txt");
  }
});

it.skipIf(process.platform === "win32")("rejects linked files and linked Electron resource directories", async () => {
  const { root, resources } = await fixture();
  const { verifyPackagedLegalResources } = await verifier();
  const original = join(resources, "electron/LICENSE.txt");
  const outside = join(root, "license-outside-package");
  await writeFile(outside, await readFile(original));
  await rm(original);
  await symlink(outside, original);
  await expect(verifyPackagedLegalResources(resources)).rejects.toThrow("legal resource electron/LICENSE.txt");
  await rm(join(resources, "electron"), { recursive: true });
  await mkdir(join(root, "external-electron"));
  await symlink(join(root, "external-electron"), join(resources, "electron"), "dir");
  await expect(verifyPackagedLegalResources(resources)).rejects.toThrow("legal resource electron/LICENSE.txt");
});
