import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startRuntime, type RunningRuntime } from "../../src/server";
import { RuntimeStore } from "../../src/server/database";
import type { ServerEvent } from "../../src/shared/contracts";
import {
  connectRuntime,
} from "../support/runtime-event-queue";
import {
  refreshRuntimeRootGitAuthority,
  requestRuntimeGit,
} from "../support/runtime-git-request";
import { SecureFileTestBroker } from "../support/secure-file-test-broker";

const runtimes: RunningRuntime[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

describe("runtime root Git authority", () => {
  it("issues fresh authority for an isolated linked checkout before branch mutations", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-runtime-root-authority-"));
    roots.push(root);
    const data = join(root, "data");
    const workspace = join(root, "workspace");
    mkdirSync(data);
    mkdirSync(workspace);
    git(workspace, "init", "-q", "--initial-branch=main");
    git(workspace, "config", "user.email", "runtime@example.invalid");
    git(workspace, "config", "user.name", "Runtime Test");
    writeFileSync(join(workspace, "README.md"), "initial\n");
    git(workspace, "add", "--", "README.md");
    git(workspace, "commit", "-q", "-m", "Initial");
    const store = new RuntimeStore(join(data, "inertia.sqlite"), workspace);
    const project = store.createProject("Authority project", workspace);
    store.createConversation(project.id, "Existing chat");
    store.close();

    const runtime = await startRuntime({
      dataDirectory: data,
      defaultWorkspacePath: workspace,
      enableProviders: false,
      secureFiles: new SecureFileTestBroker(),
    });
    runtimes.push(runtime);
    const client = await connectRuntime(runtime.websocketUrl);
    const welcome = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
        event.type === "server.welcome",
    );
    const projectId = welcome.snapshot.activeProjectId!;
    const title = "Isolated authority chat";
    const requestDeadlineAt = Date.now() + 30_000;
    const createRequestId = randomUUID();
    client.socket.send(JSON.stringify({
      type: "conversation.create",
      requestId: createRequestId,
      payload: {
        projectId,
        title,
        useWorktree: true,
        providerId: "codex",
        model: "global-default-model",
        reasoningEffort: "high",
        interactionMode: "build",
        accessMode: "supervised",
      },
    }));
    await client.events.nextForRequest(
      createRequestId,
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === createRequestId,
      requestDeadlineAt,
    );
    const snapshot = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.conversations.some(
          (conversation) => conversation.title === title && conversation.worktreePath,
        ),
    );
    const conversation = snapshot.snapshot.conversations.find(
      (candidate) => candidate.title === title,
    )!;
    const worktree = conversation.worktreePath!;
    const projectBranch = git(workspace, "branch", "--show-current");
    const chatBranch = `regression/${randomUUID().slice(0, 8)}`;
    const identity = { projectId, conversationId: conversation.id };

    await requestRuntimeGit(
      client.socket,
      client.events,
      "git.branch.create",
      {
        ...await refreshRuntimeRootGitAuthority(
          client.socket,
          client.events,
          identity,
          requestDeadlineAt,
        ),
        name: chatBranch,
      },
      "git.action",
      requestDeadlineAt,
    );

    expect(git(worktree, "branch", "--show-current")).toBe(chatBranch);
    expect(git(workspace, "branch", "--show-current")).toBe(projectBranch);

    await requestRuntimeGit(
      client.socket,
      client.events,
      "git.branch.switch",
      {
        ...await refreshRuntimeRootGitAuthority(
          client.socket,
          client.events,
          identity,
          requestDeadlineAt,
        ),
        name: conversation.branch,
      },
      "git.action",
      requestDeadlineAt,
    );
    expect(git(worktree, "branch", "--show-current"))
      .toBe(conversation.branch);
  });
});
