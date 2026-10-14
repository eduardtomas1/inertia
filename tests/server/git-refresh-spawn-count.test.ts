import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

const inspections = vi.hoisted(() => ({ args: [] as string[][] }));

vi.mock("../../src/server/git/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/git/runner")>();
  return {
    ...actual,
    runGitInspection: vi.fn(async (...call: Parameters<typeof actual.runGitInspection>) => {
      inspections.args.push([...call[1]]);
      return await actual.runGitInspection(...call);
    }),
  };
});

import {
  createSourceControlCommandHandler,
  type SourceControlCommandDependencies,
} from "../../src/server/runtime/commands/source-control-commands";
import { SecureFileAuthorityRegistry } from "../../src/server/runtime/secure-file-authorities";
import type { RuntimeSecureFileBroker } from "../../src/server/secure-files";
import { clientCommandSchema } from "../../src/shared/contracts";

const projectId = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

function secureFiles(): RuntimeSecureFileBroker {
  return {
    authorizeRoot: vi.fn(async (root: string) => {
      const canonical = realpathSync(root);
      const info = lstatSync(canonical, { bigint: true });
      return {
        root: canonical,
        identity: { dev: info.dev.toString(10), ino: info.ino.toString(10) },
        birthtimeNs: info.birthtimeNs.toString(10),
      };
    }),
    verifyRoot: vi.fn(async () => undefined),
    read: vi.fn(),
    replace: vi.fn(),
  } as unknown as RuntimeSecureFileBroker;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  inspections.args.length = 0;
});

function repositoryFixture(): string {
  const repository = mkdtempSync(join(tmpdir(), "inertia-refresh-spawns-"));
  roots.push(repository);
  git(repository, "init", "-q", "--initial-branch=main");
  git(repository, "config", "user.email", "tests@inertia.invalid");
  git(repository, "config", "user.name", "Inertia Tests");
  git(repository, "remote", "add", "origin", "https://github.com/example/project.git");
  return repository;
}

async function refresh(repository: string) {
  const send = vi.fn();
  const broker = secureFiles();
  const handler = createSourceControlCommandHandler({
    workspacePath: vi.fn(() => repository),
    secureFiles: broker,
    secureFileAuthorities: new SecureFileAuthorityRegistry(broker),
    send,
    broadcastSnapshot: vi.fn(),
  } as unknown as SourceControlCommandDependencies);
  const requestId = crypto.randomUUID();
  await expect(handler({ readyState: WebSocket.OPEN } as WebSocket, clientCommandSchema.parse({
    type: "git.refresh",
    requestId,
    payload: { projectId },
  }))).resolves.toBe("handled");
  const result = send.mock.calls.find(([, event]) => event.requestId === requestId)?.[1];
  expect(result?.result.status.authorityRef).toEqual(expect.any(String));
  return {
    status: result?.result.status,
    paths: result?.result.status.files.map((file: { path: string }) => file.path).sort(),
  };
}

describe("git.refresh Git invocations", () => {
  it("reads a committed repository with at most seven Git inspections", async () => {
    const repository = repositoryFixture();
    writeFileSync(join(repository, "README.md"), "before\n");
    git(repository, "add", "--", "README.md");
    git(repository, "commit", "-q", "-m", "Initial");
    writeFileSync(join(repository, "README.md"), "after\n");
    writeFileSync(join(repository, "notes.txt"), "new\n");

    const { status, paths } = await refresh(repository);

    expect(status).toMatchObject({ branch: "main", hasRemote: true, insertions: 1, deletions: 1 });
    expect(paths).toEqual(["README.md", "notes.txt"]);
    expect(inspections.args.length).toBeLessThanOrEqual(7);
  });

  it("reads staged changes on an unborn branch with at most seven Git inspections", async () => {
    const repository = repositoryFixture();
    writeFileSync(join(repository, "staged.txt"), "one\ntwo\n");
    git(repository, "add", "--", "staged.txt");

    const { status, paths } = await refresh(repository);

    expect(status).toMatchObject({ branch: "main", hasRemote: true, insertions: 2, deletions: 0 });
    expect(paths).toEqual(["staged.txt"]);
    expect(inspections.args.length).toBeLessThanOrEqual(7);
  });
});
