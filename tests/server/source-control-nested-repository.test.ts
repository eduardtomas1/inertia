import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSourceControlCommandHandler,
  type SourceControlCommandDependencies,
} from "../../src/server/runtime/commands/source-control-commands";
import { captureGitCommitReview } from "../../src/server/git/commit-review";
import { SecureFileAuthorityRegistry } from "../../src/server/runtime/secure-file-authorities";
import type { RuntimeSecureFileBroker } from "../../src/server/secure-files";
import { repositoryMetadataMarkerIdentity } from "../../src/server/git/paths";
import { WorkspaceRunController } from "../../src/server/runtime/workspace-run-controller";
import { clientCommandSchema } from "../../src/shared/contracts";

const projectId = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

function workspaceWithNestedRepository(): {
  workspace: string;
  repository: string;
} {
  const workspace = mkdtempSync(join(tmpdir(), "inertia-nested-action-"));
  roots.push(workspace);
  const repository = join(workspace, "modules", "alpha");
  initializeRepository(repository);
  return { workspace, repository };
}

function initializeRepository(repository: string): void {
  mkdirSync(repository, { recursive: true });
  git(repository, "init", "-q", "--initial-branch=main");
  git(repository, "config", "user.email", "tests@inertia.invalid");
  git(repository, "config", "user.name", "Inertia Tests");
  writeFileSync(join(repository, "README.md"), "before\n");
  git(repository, "add", "--", "README.md");
  git(repository, "commit", "-q", "-m", "Initial");
}

function replaceRepositoryMetadata(
  workspace: string,
  repository: string,
): void {
  renameSync(join(repository, ".git"), join(workspace, "retained-old-git"));
  git(repository, "init", "-q", "--initial-branch=main");
  git(repository, "config", "user.email", "tests@inertia.invalid");
  git(repository, "config", "user.name", "Inertia Tests");
  git(repository, "add", "--", "README.md");
  git(repository, "commit", "-q", "-m", "Replacement initial");
}

function secureFiles(options: {
  generation?: () => string;
  fixedIdentity?: { dev: string; ino: string };
} = {}): RuntimeSecureFileBroker {
  const rootGeneration = (root: string): string => options.generation?.()
    ?? lstatSync(root, { bigint: true }).birthtimeNs.toString(10);
  return {
    authorizeRoot: vi.fn(async (root: string) => {
      const canonical = realpathSync(root);
      const info = lstatSync(canonical, { bigint: true });
      return {
        root: canonical,
        identity: {
          dev: options.fixedIdentity?.dev ?? info.dev.toString(10),
          ino: options.fixedIdentity?.ino ?? info.ino.toString(10),
        },
        birthtimeNs: rootGeneration(canonical),
      };
    }),
    verifyRoot: vi.fn(async (capability) => {
      const info = lstatSync(capability.root, { bigint: true });
      if (
        (options.fixedIdentity?.dev ?? info.dev.toString(10)) !== capability.identity.dev
        || (options.fixedIdentity?.ino ?? info.ino.toString(10)) !== capability.identity.ino
        || rootGeneration(capability.root) !== capability.birthtimeNs
      ) {
        throw new Error("The secure root identity changed.");
      }
    }),
    read: vi.fn(),
    replace: vi.fn(),
  };
}

async function issueCommitReview(
  authorities: SecureFileAuthorityRegistry,
  socket: WebSocket,
  broker: RuntimeSecureFileBroker,
  workspace: string,
  repository: string,
  metadataMarkerIdentity: string,
  conversationId?: string,
): Promise<{ authorityRef: string; fingerprint: string }> {
  const review = await captureGitCommitReview(repository);
  return {
    authorityRef: await authorities.issue(
      socket,
      "git-commit-review",
      [
        projectId,
        conversationId ?? "",
        workspace,
        "modules/alpha",
        metadataMarkerIdentity,
        review.fingerprint,
      ],
      await broker.authorizeRoot(repository),
    ),
    fingerprint: review.fingerprint,
  };
}

async function nestedCommitHarness(
  workspace: string,
  repository: string,
  broker: RuntimeSecureFileBroker,
  message: string,
  paths: readonly string[],
  conversationId?: string,
  workspaceRuns?: SourceControlCommandDependencies["workspaceRuns"],
) {
  const authorities = new SecureFileAuthorityRegistry(broker);
  const socket = {} as WebSocket;
  const metadataMarkerIdentity = await repositoryMetadataMarkerIdentity(
    repository,
  );
  const authorityRef = await authorities.issue(
    socket,
    "git-repository",
    [
      projectId,
      conversationId ?? "",
      workspace,
      "modules/alpha",
      metadataMarkerIdentity,
    ],
    await broker.authorizeRoot(repository),
  );
  const reviewReceipt = await issueCommitReview(
    authorities,
    socket,
    broker,
    workspace,
    repository,
    metadataMarkerIdentity,
    conversationId,
  );
  const trackSourceControl = workspaceRuns
    ? vi.spyOn(workspaceRuns, "trackSourceControl")
    : vi.fn(async (
        _label: string,
        _projectId: string,
        _conversationId: string | undefined,
        _cwd: string,
        _requestId: string,
        operation: () => Promise<unknown>,
      ) => await operation());
  const send = vi.fn();
  const broadcastSnapshot = vi.fn();
  const handler = createSourceControlCommandHandler({
    workspacePath: vi.fn(() => workspace),
    workspaceRuns: workspaceRuns ?? { trackSourceControl },
    secureFiles: broker,
    secureFileAuthorities: authorities,
    send,
    broadcastSnapshot,
  } as unknown as SourceControlCommandDependencies);
  const command = clientCommandSchema.parse({
    type: "git.commit",
    requestId: crypto.randomUUID(),
    payload: {
      projectId,
      ...(conversationId ? { conversationId } : {}),
      repositoryPath: "modules/alpha",
      authorityRef,
      message,
      paths,
      reviewReceipt,
    },
  });
  return {
    broadcastSnapshot,
    command,
    handler,
    send,
    socket,
    trackSourceControl,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("nested source-control command scope", () => {
  it("commits in the selected nested repository while reserving its owning workspace", async () => {
    const { workspace, repository } = workspaceWithNestedRepository();
    writeFileSync(join(repository, "README.md"), "after\n");
    const broker = secureFiles();
    const authorities = new SecureFileAuthorityRegistry(broker);
    const socket = {} as WebSocket;
    const metadataMarkerIdentity = await repositoryMetadataMarkerIdentity(
      repository,
    );
    const discoveredRoot = await broker.authorizeRoot(repository);
    const authorityRef = await authorities.issue(
      socket,
      "git-repository",
      [
        projectId,
        "",
        workspace,
        "modules/alpha",
        metadataMarkerIdentity,
      ],
      {
        ...discoveredRoot,
        root: `${discoveredRoot.root}${sep}.`,
      },
    );
    const reviewReceipt = await issueCommitReview(
      authorities,
      socket,
      broker,
      workspace,
      repository,
      metadataMarkerIdentity,
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
    const command = clientCommandSchema.parse({
      type: "git.commit",
      requestId: crypto.randomUUID(),
      payload: {
        projectId,
        repositoryPath: "modules/alpha",
        authorityRef,
        message: "Commit nested change",
        paths: ["README.md"],
        reviewReceipt,
      },
    });

    await expect(handler(socket, command)).resolves.toBe("handled");

    expect(trackSourceControl).toHaveBeenCalledWith(
      "Commit changes",
      projectId,
      undefined,
      workspace,
      command.requestId,
      expect.any(Function),
    );
    expect(git(repository, "log", "-1", "--pretty=%s")).toBe(
      "Commit nested change",
    );
    expect(git(repository, "status", "--porcelain")).toBe("");
    expect(broker.authorizeRoot).toHaveBeenCalledWith(realpathSync(repository));
    expect(broker.verifyRoot).toHaveBeenCalledTimes(13);
    expect(vi.mocked(broker.verifyRoot).mock.calls.map(
      ([root]) => realpathSync(root.root),
    ))
      .toEqual(Array.from({ length: 13 }, () => realpathSync(repository)));
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "request.result",
        requestId: command.requestId,
        result: expect.objectContaining({ kind: "git.action" }),
      }),
    );
  });

  it("acknowledges one commit when post-ref containment refresh fails", async () => {
    const { workspace, repository } = workspaceWithNestedRepository();
    writeFileSync(join(repository, "README.md"), "after containment refresh\n");
    const broker = secureFiles();
    const baseVerify = vi.mocked(broker.verifyRoot).getMockImplementation();
    if (!baseVerify) throw new Error("Expected secure-root verifier.");
    vi.mocked(broker.verifyRoot).mockImplementation(async (capability, signal) => {
      await baseVerify(capability, signal);
      if (git(repository, "log", "-1", "--pretty=%s") === "Commit once") {
        throw new Error("Injected post-commit containment refresh failure.");
      }
    });
    const harness = await nestedCommitHarness(
      workspace,
      repository,
      broker,
      "Commit once",
      ["README.md"],
    );
    const before = Number(git(repository, "rev-list", "--count", "HEAD"));

    await expect(harness.handler(harness.socket, harness.command))
      .resolves.toBe("handled");

    expect(Number(git(repository, "rev-list", "--count", "HEAD")))
      .toBe(before + 1);
    expect(git(repository, "log", "-1", "--pretty=%s")).toBe("Commit once");
    expect(harness.trackSourceControl).toHaveBeenCalledOnce();
    expect(harness.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "request.result",
        requestId: harness.command.requestId,
        result: expect.objectContaining({
          kind: "git.action",
          message: expect.stringMatching(/Committed .*repository identity.*refreshed/iu),
        }),
      }),
    );
    expect(harness.broadcastSnapshot).toHaveBeenCalled();
  });

  it("acknowledges an advanced commit when run persistence and live broadcasts fail", async () => {
    const { workspace, repository } = workspaceWithNestedRepository();
    writeFileSync(join(repository, "README.md"), "authoritative commit\n");
    const activityStore = {
      conversation: vi.fn(),
      createWorkspaceRun: vi.fn(() => ({ id: crypto.randomUUID() })),
      updateWorkspaceRun: vi.fn((
        _runId: string,
        update: { status?: string },
      ) => {
        if (update.status === "succeeded") {
          throw new Error("Injected succeeded activity persistence failure.");
        }
      }),
      conversationWork: {
        reserveCheckout: vi.fn(() => true),
        release: vi.fn(),
      },
    };
    const controllerBroadcast = vi.fn(() => {
      throw new Error("Injected live snapshot failure.");
    });
    const invalidated = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("Injected invalidation failure.");
      });
    const controller = new WorkspaceRunController(
      activityStore as never,
      {} as never,
      controllerBroadcast,
      () => false,
      invalidated,
    );
    const harness = await nestedCommitHarness(
      workspace,
      repository,
      secureFiles(),
      "Commit despite projection failures",
      ["README.md"],
      undefined,
      controller,
    );
    const before = Number(git(repository, "rev-list", "--count", "HEAD"));

    await expect(harness.handler(harness.socket, harness.command))
      .resolves.toBe("handled");

    expect(Number(git(repository, "rev-list", "--count", "HEAD")))
      .toBe(before + 1);
    expect(harness.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "request.result",
        requestId: harness.command.requestId,
        result: expect.objectContaining({ kind: "git.action" }),
      }),
    );
    await expect(controller.trackSourceControl(
      "Follow-up mutation",
      projectId,
      undefined,
      workspace,
      crypto.randomUUID(),
      async () => "follow-up",
    )).resolves.toBe("follow-up");
    expect(invalidated).toHaveBeenCalledTimes(2);
    expect(activityStore.conversationWork.release).toHaveBeenCalledTimes(2);
  });

  it("acknowledges one commit when post-commit review reconciliation fails", async () => {
    const { workspace, repository } = workspaceWithNestedRepository();
    writeFileSync(join(repository, "README.md"), "after review refresh\n");
    writeFileSync(join(repository, "left-untracked.txt"), "still pending\n");
    const broker = secureFiles();
    vi.mocked(broker.read).mockRejectedValue(
      new Error("Injected review diff read failure."),
    );
    const harness = await nestedCommitHarness(
      workspace,
      repository,
      broker,
      "Commit reviewed path once",
      ["README.md"],
      "22222222-2222-4222-8222-222222222222",
    );
    const before = Number(git(repository, "rev-list", "--count", "HEAD"));

    await expect(harness.handler(harness.socket, harness.command))
      .resolves.toBe("handled");

    expect(Number(git(repository, "rev-list", "--count", "HEAD")))
      .toBe(before + 1);
    expect(git(repository, "log", "-1", "--pretty=%s"))
      .toBe("Commit reviewed path once");
    expect(readFileSync(join(repository, "left-untracked.txt"), "utf8"))
      .toBe("still pending\n");
    if (harness.command.type !== "git.commit") {
      throw new Error("Expected parsed Git commit command.");
    }
    expect(harness.command.payload.conversationId)
      .toBe("22222222-2222-4222-8222-222222222222");
    expect(broker.read).toHaveBeenCalled();
    expect(harness.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "request.result",
        requestId: harness.command.requestId,
        result: expect.objectContaining({
          kind: "git.action",
          message: expect.stringMatching(/review state could not be refreshed/iu),
        }),
      }),
    );
    expect(harness.broadcastSnapshot).toHaveBeenCalled();
  });

  it("rejects a repository path that escapes the active workspace before reserving it", async () => {
    const { workspace } = workspaceWithNestedRepository();
    const trackSourceControl = vi.fn();
    const handler = createSourceControlCommandHandler({
      workspacePath: vi.fn(() => workspace),
      workspaceRuns: { trackSourceControl },
      secureFiles: secureFiles(),
    } as unknown as SourceControlCommandDependencies);
    const command = clientCommandSchema.parse({
      type: "git.push",
      requestId: crypto.randomUUID(),
      payload: {
        projectId,
        repositoryPath: "../outside",
        authorityRef: crypto.randomUUID(),
      },
    });

    await expect(handler({} as WebSocket, command)).rejects.toThrow(
      /repository path is invalid/iu,
    );
    expect(trackSourceControl).not.toHaveBeenCalled();
  });

  it("rejects a replaced repository at the same path before a mutation starts", async () => {
    const { workspace, repository } = workspaceWithNestedRepository();
    writeFileSync(join(repository, "README.md"), "pending change\n");
    const initialInfo = lstatSync(repository, { bigint: true });
    let generation = initialInfo.birthtimeNs.toString(10);
    const broker = secureFiles({
      generation: () => generation,
      fixedIdentity: {
        dev: initialInfo.dev.toString(10),
        ino: initialInfo.ino.toString(10),
      },
    });
    const authorities = new SecureFileAuthorityRegistry(broker);
    const socket = {} as WebSocket;
    const metadataMarkerIdentity = await repositoryMetadataMarkerIdentity(
      repository,
    );
    const authorityRef = await authorities.issue(
      socket,
      "git-repository",
      [
        projectId,
        "",
        workspace,
        "modules/alpha",
        metadataMarkerIdentity,
      ],
      await broker.authorizeRoot(repository),
    );
    const reviewReceipt = await issueCommitReview(
      authorities,
      socket,
      broker,
      workspace,
      repository,
      metadataMarkerIdentity,
    );
    const trackSourceControl = vi.fn(async (
      _label: string,
      _projectId: string,
      _conversationId: string | undefined,
      _cwd: string,
      _requestId: string,
      operation: () => Promise<unknown>,
    ) => {
      rmSync(repository, { recursive: true, force: true });
      initializeRepository(repository);
      writeFileSync(join(repository, "README.md"), "replacement change\n");
      generation = (initialInfo.birthtimeNs + 1n).toString(10);
      return await operation();
    });
    const handler = createSourceControlCommandHandler({
      workspacePath: vi.fn(() => workspace),
      workspaceRuns: { trackSourceControl },
      secureFiles: broker,
      secureFileAuthorities: authorities,
    } as unknown as SourceControlCommandDependencies);
    const command = clientCommandSchema.parse({
      type: "git.commit",
      requestId: crypto.randomUUID(),
      payload: {
        projectId,
        repositoryPath: "modules/alpha",
        authorityRef,
        message: "Must not reach replacement",
        paths: ["README.md"],
        reviewReceipt,
      },
    });

    await expect(handler(socket, command)).rejects.toThrow(
      /secure root identity changed/iu,
    );
    expect(trackSourceControl).toHaveBeenCalledOnce();
    expect(git(repository, "log", "-1", "--pretty=%s")).toBe("Initial");
    expect(git(repository, "status", "--porcelain")).toBe("M README.md");
    expect(broker.verifyRoot).toHaveBeenCalled();
  });

  it("rejects replaced Git metadata before mutating the repository", async () => {
    const { workspace, repository } = workspaceWithNestedRepository();
    const broker = secureFiles();
    const authorities = new SecureFileAuthorityRegistry(broker);
    const socket = {} as WebSocket;
    const metadataMarkerIdentity = await repositoryMetadataMarkerIdentity(
      repository,
    );
    const authorityRef = await authorities.issue(
      socket,
      "git-repository",
      [
        projectId,
        "",
        workspace,
        "modules/alpha",
        metadataMarkerIdentity,
      ],
      await broker.authorizeRoot(repository),
    );
    writeFileSync(join(repository, "README.md"), "pending change\n");
    const reviewReceipt = await issueCommitReview(
      authorities,
      socket,
      broker,
      workspace,
      repository,
      metadataMarkerIdentity,
    );
    const trackSourceControl = vi.fn(async (
      _label: string,
      _projectId: string,
      _conversationId: string | undefined,
      _cwd: string,
      _requestId: string,
      operation: () => Promise<unknown>,
    ) => {
      replaceRepositoryMetadata(workspace, repository);
      writeFileSync(join(repository, "README.md"), "replacement change\n");
      return await operation();
    });
    const handler = createSourceControlCommandHandler({
      workspacePath: vi.fn(() => workspace),
      workspaceRuns: { trackSourceControl },
      secureFiles: broker,
      secureFileAuthorities: authorities,
    } as unknown as SourceControlCommandDependencies);
    const command = clientCommandSchema.parse({
      type: "git.commit",
      requestId: crypto.randomUUID(),
      payload: {
        projectId,
        repositoryPath: "modules/alpha",
        authorityRef,
        message: "Must not mutate replacement metadata",
        paths: ["README.md"],
        reviewReceipt,
      },
    });

    await expect(handler(socket, command)).rejects.toThrow(
      /repository changed after its status was loaded/iu,
    );
    expect(trackSourceControl).toHaveBeenCalledOnce();
    expect(git(repository, "log", "-1", "--pretty=%s")).toBe(
      "Replacement initial",
    );
    expect(git(repository, "status", "--porcelain")).toBe("M README.md");
  });

  it("rejects replaced Git metadata before reading its corrupt index", async () => {
    const { workspace, repository } = workspaceWithNestedRepository();
    const broker = secureFiles();
    const authorities = new SecureFileAuthorityRegistry(broker);
    const socket = {} as WebSocket;
    const metadataMarkerIdentity = await repositoryMetadataMarkerIdentity(
      repository,
    );
    const authorityRef = await authorities.issue(
      socket,
      "git-repository",
      [
        projectId,
        "",
        workspace,
        "modules/alpha",
        metadataMarkerIdentity,
      ],
      await broker.authorizeRoot(repository),
    );
    replaceRepositoryMetadata(workspace, repository);
    writeFileSync(join(repository, ".git", "index"), "not a Git index\n");
    const trackSourceControl = vi.fn();
    const handler = createSourceControlCommandHandler({
      workspacePath: vi.fn(() => workspace),
      workspaceRuns: { trackSourceControl },
      secureFiles: broker,
      secureFileAuthorities: authorities,
    } as unknown as SourceControlCommandDependencies);
    const command = clientCommandSchema.parse({
      type: "git.commit",
      requestId: crypto.randomUUID(),
      payload: {
        projectId,
        repositoryPath: "modules/alpha",
        authorityRef,
        message: "Must reject before status",
        paths: ["README.md"],
        reviewReceipt: {
          authorityRef: crypto.randomUUID(),
          fingerprint: "a".repeat(64),
        },
      },
    });

    await expect(handler(socket, command)).rejects.toThrow(
      /filesystem authorization expired|refresh and try again/iu,
    );
    expect(trackSourceControl).not.toHaveBeenCalled();
    expect(git(repository, "log", "-1", "--pretty=%s")).toBe(
      "Replacement initial",
    );
  });

  it("rejects an external core.worktree redirect before mutation", async () => {
    const { workspace, repository } = workspaceWithNestedRepository();
    const outside = mkdtempSync(join(tmpdir(), "inertia-external-worktree-"));
    roots.push(outside);
    writeFileSync(join(outside, "README.md"), "outside\n");
    const broker = secureFiles();
    const authorities = new SecureFileAuthorityRegistry(broker);
    const socket = {} as WebSocket;
    const metadataMarkerIdentity = await repositoryMetadataMarkerIdentity(
      repository,
    );
    const authorityRef = await authorities.issue(
      socket,
      "git-repository",
      [
        projectId,
        "",
        workspace,
        "modules/alpha",
        metadataMarkerIdentity,
      ],
      await broker.authorizeRoot(repository),
    );
    writeFileSync(join(repository, "README.md"), "pending change\n");
    const reviewReceipt = await issueCommitReview(
      authorities,
      socket,
      broker,
      workspace,
      repository,
      metadataMarkerIdentity,
    );
    const trackSourceControl = vi.fn(async (
      _label: string,
      _projectId: string,
      _conversationId: string | undefined,
      _cwd: string,
      _requestId: string,
      operation: () => Promise<unknown>,
    ) => {
      git(repository, "config", "core.worktree", outside);
      return await operation();
    });
    const handler = createSourceControlCommandHandler({
      workspacePath: vi.fn(() => workspace),
      workspaceRuns: { trackSourceControl },
      secureFiles: broker,
      secureFileAuthorities: authorities,
    } as unknown as SourceControlCommandDependencies);
    const command = clientCommandSchema.parse({
      type: "git.commit",
      requestId: crypto.randomUUID(),
      payload: {
        projectId,
        repositoryPath: "modules/alpha",
        authorityRef,
        message: "Must not escape the selected worktree",
        paths: ["README.md"],
        reviewReceipt,
      },
    });

    await expect(handler(socket, command)).rejects.toThrow(
      /repository changed after its status was loaded/iu,
    );
    expect(trackSourceControl).toHaveBeenCalledOnce();
    expect(readFileSync(join(outside, "README.md"), "utf8")).toBe("outside\n");
  });
});
