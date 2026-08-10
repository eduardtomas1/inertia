import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SecureFileAuthorityRegistry } from "../../src/server/runtime/secure-file-authorities";
import { SecureFileTestBroker } from "../support/secure-file-test-broker";

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const container = await mkdtemp(join(tmpdir(), "inertia-authority-"));
  temporaryDirectories.push(container);
  const root = join(container, "root");
  await mkdir(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(
      (directory) => rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("SecureFileAuthorityRegistry", () => {
  it("does not commit an authority after its verification is aborted", async () => {
    const base = new SecureFileTestBroker();
    const root = await base.authorizeRoot(await temporaryRoot());
    let releaseVerification!: () => void;
    const verification = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    let verificationSignal: AbortSignal | undefined;
    const secureFiles: typeof base = Object.assign(
      Object.create(Object.getPrototypeOf(base)) as SecureFileTestBroker,
      base,
      {
        verifyRoot: async (
          capability: typeof root,
          signal?: AbortSignal,
        ): Promise<void> => {
          verificationSignal = signal;
          await verification;
          // Deliberately ignore cancellation like an already-started
          // filesystem primitive; the registry must fence the late commit.
          await base.verifyRoot(capability);
        },
      },
    );
    const owner = {};
    const reference = "late-authority-reference";
    const registry = new SecureFileAuthorityRegistry(secureFiles, {
      createReference: () => reference,
    });
    const controller = new AbortController();
    const issuing = registry.issue(
      owner,
      "git-repository",
      ["project", "."],
      root,
      { signal: controller.signal },
    );

    controller.abort();
    releaseVerification();

    await expect(issuing).rejects.toThrow(/authorization expired/i);
    expect(verificationSignal).toBe(controller.signal);
    await expect(registry.resolve(
      owner,
      reference,
      "git-repository",
      ["project", "."],
    )).rejects.toThrow(/authorization expired/i);
  });

  it("binds opaque references to their owner, purpose, and exact context", async () => {
    const secureFiles = new SecureFileTestBroker();
    const registry = new SecureFileAuthorityRegistry(secureFiles);
    const root = await secureFiles.authorizeRoot(await temporaryRoot());
    const owner = {};
    const reference = await registry.issue(
      owner,
      "workspace-save",
      ["project", "file.ts", "digest"],
      root,
    );

    await expect(registry.resolve(
      {},
      reference,
      "workspace-save",
      ["project", "file.ts", "digest"],
    )).rejects.toThrow(/authorization expired/i);
    await expect(registry.resolve(
      owner,
      reference,
      "git-repository",
      ["project", "file.ts", "digest"],
    )).rejects.toThrow(/authorization expired/i);
    await expect(registry.resolve(
      owner,
      reference,
      "workspace-save",
      ["project", "other.ts", "digest"],
    )).rejects.toThrow(/authorization expired/i);
    await expect(registry.resolve(
      owner,
      reference,
      "workspace-save",
      ["project", "file.ts", "digest"],
    )).resolves.toEqual(root);
  });

  it("fails closed after a root swap and across a runtime-registry restart", async () => {
    const secureFiles = new SecureFileTestBroker();
    const registry = new SecureFileAuthorityRegistry(secureFiles);
    const rootPath = await temporaryRoot();
    const outside = await temporaryRoot();
    const movedRoot = `${rootPath}-moved`;
    const root = await secureFiles.authorizeRoot(rootPath);
    const owner = {};
    const reference = await registry.issue(
      owner,
      "git-repository",
      ["project", "."],
      root,
    );

    const restartedRegistry = new SecureFileAuthorityRegistry(secureFiles);
    await expect(restartedRegistry.resolve(
      owner,
      reference,
      "git-repository",
      ["project", "."],
    )).rejects.toThrow(/authorization expired/i);

    await rename(rootPath, movedRoot);
    await symlink(
      outside,
      rootPath,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(registry.resolve(
      owner,
      reference,
      "git-repository",
      ["project", "."],
    )).rejects.toThrow(/authorization expired/i);
  });

  it("evicts the oldest reference at its configured bound", async () => {
    const secureFiles = new SecureFileTestBroker();
    const registry = new SecureFileAuthorityRegistry(secureFiles, {
      maxAuthorities: 1,
    });
    const root = await secureFiles.authorizeRoot(await temporaryRoot());
    const owner = {};
    const first = await registry.issue(owner, "git-repository", ["first"], root);
    const second = await registry.issue(owner, "git-repository", ["second"], root);

    await expect(registry.resolve(
      owner,
      first,
      "git-repository",
      ["first"],
    )).rejects.toThrow(/authorization expired/i);
    await expect(registry.resolve(
      owner,
      second,
      "git-repository",
      ["second"],
    )).resolves.toEqual(root);
  });
});
