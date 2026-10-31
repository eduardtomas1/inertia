import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_STAGING_PATHS,
  stageRepositoryPaths,
  unstageRepositoryPaths,
} from "../../src/server/git/staging";
import { repositoryMetadataMarkerIdentity } from "../../src/server/git/paths";
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
  }).trimEnd();
}

function temporaryDirectory(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(directory);
  return directory;
}

function initializeRepository(repository: string, commit = true): string {
  mkdirSync(repository, { recursive: true });
  git(repository, "init", "-q", "--initial-branch=main");
  git(repository, "config", "user.email", "tests@inertia.invalid");
  git(repository, "config", "user.name", "Inertia Tests");
  git(repository, "config", "core.autocrlf", "false");
  if (commit) {
    writeFileSync(join(repository, "README.md"), "before\n");
    writeFileSync(join(repository, "other.txt"), "other\n");
    git(repository, "add", "--", "README.md", "other.txt");
    git(repository, "commit", "-q", "-m", "Initial");
  }
  return repository;
}

function porcelain(repository: string): string[] {
  return git(repository, "status", "--porcelain=v1", "--untracked-files=all")
    .split("\n")
    .filter(Boolean)
    .sort();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("repository staging", () => {
  it("stages only the selected modified, deleted and untracked paths", async () => {
    const repository = initializeRepository(temporaryDirectory("inertia-stage-"));
    writeFileSync(join(repository, "README.md"), "after\n");
    writeFileSync(join(repository, "other.txt"), "unrelated edit\n");
    writeFileSync(join(repository, "new file.txt"), "new\n");
    mkdirSync(join(repository, "docs"));
    writeFileSync(join(repository, "docs", "[guide].md"), "literal glob name\n");
    writeFileSync(join(repository, "docs", "guide.md"), "must stay untracked\n");

    const result = await stageRepositoryPaths(repository, [
      "README.md",
      "new file.txt",
      "docs/[guide].md",
    ]);

    expect(result.paths.sort()).toEqual(["README.md", "docs/[guide].md", "new file.txt"]);
    expect(porcelain(repository)).toEqual([
      " M other.txt",
      "?? docs/guide.md",
      "A  docs/[guide].md",
      "A  \"new file.txt\"",
      "M  README.md",
    ].sort());
    expect(result.status.files.find((file) => file.path === "README.md"))
      .toMatchObject({ staged: true, unstaged: false });

    rmSync(join(repository, "other.txt"));
    await stageRepositoryPaths(repository, ["other.txt"]);
    expect(porcelain(repository)).toContain("D  other.txt");
  });

  it("unstages modified and renamed paths without touching working-tree content", async () => {
    const repository = initializeRepository(temporaryDirectory("inertia-unstage-"));
    writeFileSync(join(repository, "README.md"), "staged\n");
    git(repository, "add", "--", "README.md");
    writeFileSync(join(repository, "README.md"), "staged\nand more\n");
    git(repository, "mv", "other.txt", "renamed.txt");
    writeFileSync(join(repository, "keep-staged.txt"), "keep\n");
    git(repository, "add", "--", "keep-staged.txt");

    const result = await unstageRepositoryPaths(repository, ["README.md", "renamed.txt"]);

    expect(result.paths.sort()).toEqual(["README.md", "renamed.txt"]);
    expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("staged\nand more\n");
    expect(readFileSync(join(repository, "renamed.txt"), "utf8")).toBe("other\n");
    expect(porcelain(repository)).toEqual([
      " D other.txt",
      " M README.md",
      "?? renamed.txt",
      "A  keep-staged.txt",
    ].sort());
  });

  it("removes a newly added file from the index but keeps the file on disk", async () => {
    const repository = initializeRepository(temporaryDirectory("inertia-unstage-new-"));
    writeFileSync(join(repository, "fresh.txt"), "fresh\n");
    writeFileSync(join(repository, "edited.txt"), "first\n");
    git(repository, "add", "--", "fresh.txt", "edited.txt");
    writeFileSync(join(repository, "edited.txt"), "first\nsecond\n");

    await unstageRepositoryPaths(repository, ["fresh.txt", "edited.txt"]);

    expect(readFileSync(join(repository, "fresh.txt"), "utf8")).toBe("fresh\n");
    expect(readFileSync(join(repository, "edited.txt"), "utf8")).toBe("first\nsecond\n");
    expect(porcelain(repository)).toEqual(["?? edited.txt", "?? fresh.txt"]);
  });

  it("unstages new files before the first commit without deleting them", async () => {
    const repository = initializeRepository(temporaryDirectory("inertia-unborn-"), false);
    writeFileSync(join(repository, "a.txt"), "a\n");
    writeFileSync(join(repository, "b.txt"), "b\n");
    git(repository, "add", "--", "a.txt", "b.txt");
    writeFileSync(join(repository, "b.txt"), "b\nedited\n");

    await unstageRepositoryPaths(repository, ["a.txt", "b.txt"]);

    expect(existsSync(join(repository, "a.txt"))).toBe(true);
    expect(readFileSync(join(repository, "b.txt"), "utf8")).toBe("b\nedited\n");
    expect(porcelain(repository)).toEqual(["?? a.txt", "?? b.txt"]);
  });

  it("rejects paths outside the repository, unchanged paths and symbolic-link escapes", async () => {
    const repository = initializeRepository(temporaryDirectory("inertia-stage-guard-"));
    const outside = temporaryDirectory("inertia-stage-outside-");
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    symlinkSync(outside, join(repository, "escape"), "dir");
    writeFileSync(join(repository, "README.md"), "after\n");
    const before = porcelain(repository);

    for (const path of ["../outside.txt", join(outside, "secret.txt"), "escape/secret.txt", ":(glob)*"]) {
      await expect(stageRepositoryPaths(repository, [path])).rejects.toMatchObject({
        code: "invalid-input",
      });
    }
    await expect(stageRepositoryPaths(repository, ["other.txt"])).rejects.toMatchObject({
      code: "conflict",
      message: "A selected file is no longer changed. Refresh and try again.",
    });
    await expect(unstageRepositoryPaths(repository, ["escape/secret.txt"])).rejects.toMatchObject({
      code: "invalid-input",
    });
    expect(porcelain(repository)).toEqual(before);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret\n");
  });

  it("caps one request at 200 paths", async () => {
    const repository = initializeRepository(temporaryDirectory("inertia-stage-cap-"));
    const paths = Array.from({ length: MAX_STAGING_PATHS }, (_, index) => `file-${index}.txt`);
    for (const path of paths) writeFileSync(join(repository, path), `${path}\n`);

    await expect(stageRepositoryPaths(repository, [...paths, "README.md"])).rejects.toMatchObject({
      code: "invalid-input",
      message: "Select between 1 and 200 repository files.",
    });
    await expect(stageRepositoryPaths(repository, [])).rejects.toMatchObject({ code: "invalid-input" });
    expect(porcelain(repository).every((line) => line.startsWith("??"))).toBe(true);

    const staged = await stageRepositoryPaths(repository, paths);
    expect(staged.paths).toHaveLength(MAX_STAGING_PATHS);
    expect(porcelain(repository).filter((line) => line.startsWith("A "))).toHaveLength(MAX_STAGING_PATHS);
  });

  it("refuses to stage an embedded repository as a gitlink from its parent", async () => {
    const repository = initializeRepository(temporaryDirectory("inertia-stage-parent-"));
    initializeRepository(join(repository, "modules", "alpha"));

    await expect(stageRepositoryPaths(repository, ["modules/alpha/"])).rejects.toMatchObject({
      code: "invalid-input",
    });
    await expect(stageRepositoryPaths(repository, ["modules/alpha/README.md"])).rejects.toMatchObject({
      code: "conflict",
    });
    expect(git(repository, "ls-files", "--stage")).not.toContain("modules/alpha");
  });

  it("unstages a file that was added and then deleted without recreating it", async () => {
    const repository = initializeRepository(temporaryDirectory("inertia-unstage-ad-"));
    writeFileSync(join(repository, "brief.txt"), "brief\n");
    git(repository, "add", "--", "brief.txt");
    rmSync(join(repository, "brief.txt"));
    expect(porcelain(repository)).toEqual(["AD brief.txt"]);

    const result = await unstageRepositoryPaths(repository, ["brief.txt"]);

    expect(result.paths).toEqual(["brief.txt"]);
    expect(porcelain(repository)).toEqual([]);
    expect(existsSync(join(repository, "brief.txt"))).toBe(false);
  });

  it("unstages a staged deletion while an untracked file has the same path", async () => {
    const repository = initializeRepository(temporaryDirectory("inertia-unstage-shadow-"));
    git(repository, "rm", "--cached", "--quiet", "--", "other.txt");
    writeFileSync(join(repository, "other.txt"), "replacement\n");
    expect(porcelain(repository)).toEqual(["?? other.txt", "D  other.txt"].sort());

    const result = await unstageRepositoryPaths(repository, ["other.txt"]);

    expect(result.paths).toEqual(["other.txt"]);
    expect(porcelain(repository)).toEqual([" M other.txt"]);
    expect(readFileSync(join(repository, "other.txt"), "utf8")).toBe("replacement\n");
  });

  it("refuses to stage a file that was replaced by a folder", async () => {
    const repository = initializeRepository(temporaryDirectory("inertia-stage-folder-"));
    rmSync(join(repository, "other.txt"));
    mkdirSync(join(repository, "other.txt"));
    writeFileSync(join(repository, "other.txt", "inside.txt"), "inside\n");
    const before = porcelain(repository);

    await expect(stageRepositoryPaths(repository, ["other.txt"])).rejects.toMatchObject({
      code: "conflict",
      message: "“other.txt” is now a folder. Stage the files inside it instead.",
    });
    expect(porcelain(repository)).toEqual(before);

    await stageRepositoryPaths(repository, ["other.txt/inside.txt"]);
    expect(porcelain(repository)).toEqual(["A  other.txt/inside.txt", "D  other.txt"].sort());
  });

  it("refuses an unstage that would also reach staged files inside a same-named folder", async () => {
    const repository = initializeRepository(temporaryDirectory("inertia-unstage-folder-"));
    rmSync(join(repository, "other.txt"));
    mkdirSync(join(repository, "other.txt"));
    writeFileSync(join(repository, "other.txt", "inside.txt"), "inside\n");
    git(repository, "add", "--", "other.txt/inside.txt");
    const before = porcelain(repository);

    await expect(unstageRepositoryPaths(repository, ["other.txt"])).rejects.toMatchObject({
      code: "conflict",
    });
    expect(porcelain(repository)).toEqual(before);

    await unstageRepositoryPaths(repository, ["other.txt", "other.txt/inside.txt"]);
    expect(porcelain(repository)).toEqual([" D other.txt", "?? other.txt/inside.txt"].sort());
  });

  it("stages a tracked file inside an ignored folder", async () => {
    const repository = initializeRepository(temporaryDirectory("inertia-stage-ignored-"));
    mkdirSync(join(repository, "build"));
    writeFileSync(join(repository, "build", "kept.txt"), "kept\n");
    git(repository, "add", "--", "build/kept.txt");
    git(repository, "commit", "-q", "-m", "Track build file");
    writeFileSync(join(repository, ".gitignore"), "build/\n");
    git(repository, "add", "--", ".gitignore");
    git(repository, "commit", "-q", "-m", "Ignore build");
    writeFileSync(join(repository, "build", "kept.txt"), "changed\n");
    writeFileSync(join(repository, "build", "output.log"), "ignored\n");

    const result = await stageRepositoryPaths(repository, ["build/kept.txt"]);

    expect(result.paths).toEqual(["build/kept.txt"]);
    expect(porcelain(repository)).toEqual(["M  build/kept.txt"]);
    expect(git(repository, "ls-files", "--", "build")).toBe("build/kept.txt");
  });

  it("gives the index update its own clock and reports a stopped update with the lock hint", async () => {
    const repository = initializeRepository(temporaryDirectory("inertia-stage-clock-"));
    writeFileSync(join(repository, "README.md"), "after\n");

    await expect(stageRepositoryPaths(repository, ["README.md"], { mutationTimeoutMs: 0 }))
      .rejects.toMatchObject({ code: "timeout", message: expect.stringContaining(".git/index.lock") });
    expect(porcelain(repository)).toEqual([" M README.md"]);

    // A failed refresh after a successful update is a warning, not a failure.
    const staged = await stageRepositoryPaths(repository, ["README.md"], {
      deadlineAt: Date.now() + 60_000,
      mutationTimeoutMs: 60_000,
      refreshTimeoutMs: 0,
    });
    expect(staged.paths).toEqual(["README.md"]);
    expect(staged.refreshWarning).toBe("The index changed, but repository status could not be refreshed yet.");
    expect(staged.status.files.find((file) => file.path === "README.md"))
      .toMatchObject({ staged: false, unstaged: true });
    expect(porcelain(repository)).toEqual(["M  README.md"]);
  });

  it("refuses to stage or unstage from a truncated status", async () => {
    const repository = initializeRepository(temporaryDirectory("inertia-stage-truncated-"));
    // Index entries without working-tree files each report one long deletion
    // record, which pushes the status read past its output bound.
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repository,
      input: "",
      encoding: "utf8",
    }).trim();
    const directory = "d".repeat(1_000);
    const entries = Array.from({ length: 5_000 }, (_, index) =>
      `100644 blob ${blob}\t${directory}/${index}.txt\n`).join("");
    execFileSync("git", ["update-index", "--index-info"], { cwd: repository, input: entries });
    writeFileSync(join(repository, "README.md"), "after\n");
    const indexBefore = git(repository, "diff", "--cached", "--name-only", "--", "README.md");

    await expect(stageRepositoryPaths(repository, ["README.md"])).rejects.toMatchObject({
      code: "output-limit",
    });
    await expect(unstageRepositoryPaths(repository, ["README.md"])).rejects.toMatchObject({
      code: "output-limit",
    });
    expect(git(repository, "diff", "--cached", "--name-only", "--", "README.md")).toBe(indexBefore);
  });
});

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

async function handlerHarness(workspace: string, repository: string, repositoryPath: string) {
  const broker = secureFiles();
  const authorities = new SecureFileAuthorityRegistry(broker);
  const socket = { readyState: WebSocket.OPEN } as WebSocket;
  const authorityRef = await authorities.issue(
    socket,
    "git-repository",
    [projectId, "", workspace, repositoryPath, await repositoryMetadataMarkerIdentity(repository)],
    await broker.authorizeRoot(repository),
  );
  const trackSourceControl = vi.fn(async (
    _label: string,
    _projectId: string,
    _conversationId: string | undefined,
    _cwd: string,
    _requestId: string,
    operation: () => Promise<unknown>,
  ) => await operation());
  const send = vi.fn();
  const handler = createSourceControlCommandHandler({
    workspacePath: vi.fn(() => workspace),
    workspaceRuns: { trackSourceControl },
    secureFiles: broker,
    secureFileAuthorities: authorities,
    send,
    broadcastSnapshot: vi.fn(),
  } as unknown as SourceControlCommandDependencies);
  const execute = async (
    type: "git.stage" | "git.unstage",
    paths: string[],
    scope: { repositoryPath?: string; authorityRef?: string } = { repositoryPath, authorityRef },
  ) => await handler(socket, clientCommandSchema.parse({
    type,
    requestId: crypto.randomUUID(),
    payload: { projectId, ...scope, paths },
  }));
  return { authorityRef, execute, send, trackSourceControl };
}

describe("git.stage and git.unstage runtime commands", () => {
  it("stage and unstage inside the exact nested repository scope", async () => {
    const workspace = temporaryDirectory("inertia-stage-workspace-");
    initializeRepository(workspace);
    const nested = initializeRepository(join(workspace, "modules", "alpha"));
    writeFileSync(join(workspace, "README.md"), "root edit\n");
    writeFileSync(join(nested, "README.md"), "nested edit\n");
    const harness = await handlerHarness(workspace, nested, "modules/alpha");

    await expect(harness.execute("git.stage", ["README.md"])).resolves.toBe("handled");
    expect(porcelain(nested)).toEqual(["M  README.md"]);
    expect(porcelain(workspace)).toEqual([" M README.md", "?? modules/alpha/"].sort());
    expect(harness.trackSourceControl).toHaveBeenCalledWith(
      "Stage files",
      projectId,
      undefined,
      workspace,
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({ recoverReviewedCommit: true }),
    );
    expect(harness.send).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      result: { kind: "git.action", message: "Staged 1 file." },
    }));

    await expect(harness.execute("git.unstage", ["README.md"])).resolves.toBe("handled");
    expect(porcelain(nested)).toEqual([" M README.md"]);
    expect(readFileSync(join(nested, "README.md"), "utf8")).toBe("nested edit\n");
    expect(harness.send).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      result: {
        kind: "git.action",
        message: "Unstaged 1 file. Working-tree files are unchanged.",
      },
    }));
  });

  it("requires live repository authority and rejects escapes before Git mutates the index", async () => {
    const workspace = temporaryDirectory("inertia-stage-authority-");
    initializeRepository(workspace);
    writeFileSync(join(workspace, "README.md"), "edit\n");
    const harness = await handlerHarness(workspace, workspace, ".");

    await expect(harness.execute("git.stage", ["README.md"], {})).rejects.toThrow(
      "Refresh repository status before changing this repository.",
    );
    await expect(harness.execute("git.stage", ["README.md"], {
      repositoryPath: ".",
      authorityRef: crypto.randomUUID(),
    })).rejects.toThrow();
    await expect(harness.execute("git.stage", ["sub/../../escape.txt"])).rejects.toThrow();
    expect(porcelain(workspace)).toEqual([" M README.md"]);

    await expect(harness.execute("git.stage", ["README.md"])).resolves.toBe("handled");
    expect(porcelain(workspace)).toEqual(["M  README.md"]);
  });
});
