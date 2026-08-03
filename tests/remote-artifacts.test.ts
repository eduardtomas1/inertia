import {
  appendFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import remoteComponentVersions from "../remote/component-versions.json" with {
  type: "json",
};
import {
  buildRemoteArtifacts,
  verifyRemoteArtifacts,
  writeRemoteArtifactSet,
  type RemoteArtifactInput,
} from "../scripts/remote-artifacts.mjs";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `inertia-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

async function artifactInputs(directory: string): Promise<RemoteArtifactInput[]> {
  const rootLockfile = join(directory, "package-lock.json");
  const relayLockfile = join(directory, "relay-package-lock.json");
  await writeFile(rootLockfile, "{\"lockfileVersion\":3}\n", "utf8");
  await writeFile(relayLockfile, "{\"lockfileVersion\":3,\"relay\":true}\n", "utf8");
  return [
    {
      kind: "browser",
      version: "0.2.0",
      nodeRange: ">=22.13 <23",
      lockfilePath: rootLockfile,
      entries: [
        { path: "site/index.html", data: Buffer.from("<!doctype html>\n") },
        { path: "site/assets/app.js", data: Buffer.from("export {};\n") },
      ],
    },
    {
      kind: "relay",
      version: "0.2.0",
      nodeRange: ">=22.13 <23",
      lockfilePath: relayLockfile,
      entries: [
        { path: "README.md", data: Buffer.from("# Relay\n") },
        { path: "package-lock.json", data: await readFile(relayLockfile) },
        { path: "package.json", data: Buffer.from("{\"type\":\"module\"}\n") },
        { path: "server.mjs", data: Buffer.from("export {};\n") },
      ],
    },
  ];
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Remote Companion release artifacts", () => {
  it("uses canonical component versions in production artifact names", async () => {
    const browserDirectory = await temporaryDirectory("remote-browser-build");
    const outputDirectory = join(
      await temporaryDirectory("remote-artifact-output"),
      "set",
    );
    await writeFile(
      join(browserDirectory, "index.html"),
      "<!doctype html>\n",
      "utf8",
    );

    const built = await buildRemoteArtifacts({
      browserDirectory,
      outputDirectory,
      sourceCommit: "d".repeat(40),
    });

    expect(built.artifacts.map(({ name }) => name)).toEqual([
      `inertia-remote-browser-${remoteComponentVersions.browser}.tar.gz`,
      `inertia-remote-relay-${remoteComponentVersions.relay}.tar.gz`,
    ]);
    await expect(verifyRemoteArtifacts(outputDirectory)).resolves.toBe(true);
  });

  it("builds deterministic versioned archives with verified manifests", async () => {
    const fixture = await temporaryDirectory("remote-artifact-input");
    const firstOutput = join(await temporaryDirectory("remote-artifact-output"), "set");
    const secondOutput = join(await temporaryDirectory("remote-artifact-output"), "set");
    const components = await artifactInputs(fixture);
    const options = {
      sourceCommit: "a".repeat(40),
      components,
    };
    const first = await writeRemoteArtifactSet({
      ...options,
      outputDirectory: firstOutput,
    });
    await writeRemoteArtifactSet({
      ...options,
      outputDirectory: secondOutput,
    });

    expect(first.artifacts.map(({ name }) => name)).toEqual([
      "inertia-remote-browser-0.2.0.tar.gz",
      "inertia-remote-relay-0.2.0.tar.gz",
    ]);
    expect(await verifyRemoteArtifacts(firstOutput)).toBe(true);
    for (const artifact of first.artifacts) {
      expect(await readFile(join(firstOutput, artifact.name))).toEqual(
        await readFile(join(secondOutput, artifact.name)),
      );
    }
    expect(await readFile(
      join(firstOutput, "REMOTE-SHA256SUMS.txt"),
      "utf8",
    )).toBe(await readFile(
      join(secondOutput, "REMOTE-SHA256SUMS.txt"),
      "utf8",
    ));
  });

  it("rejects changed archives and unexpected release files", async () => {
    const fixture = await temporaryDirectory("remote-artifact-input");
    const output = join(await temporaryDirectory("remote-artifact-output"), "set");
    const built = await writeRemoteArtifactSet({
      outputDirectory: output,
      sourceCommit: "b".repeat(40),
      components: await artifactInputs(fixture),
    });
    await appendFile(join(output, built.artifacts[0]!.name), "tampered", "utf8");
    await expect(verifyRemoteArtifacts(output)).rejects.toThrow(
      "artifact integrity mismatch",
    );

    const cleanOutput = join(await temporaryDirectory("remote-artifact-output"), "set");
    await writeRemoteArtifactSet({
      outputDirectory: cleanOutput,
      sourceCommit: "c".repeat(40),
      components: await artifactInputs(fixture),
    });
    await writeFile(join(cleanOutput, "unexpected.txt"), "unexpected\n", "utf8");
    await expect(verifyRemoteArtifacts(cleanOutput)).rejects.toThrow(
      "Unexpected Remote Companion artifact file set",
    );
  });
});
