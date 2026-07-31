import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { startRuntime, type RunningRuntime } from "../../src/server";
import { RuntimeStore } from "../../src/server/database";
import { getUnifiedDiff } from "../../src/server/git";
import type { ServerEvent } from "../../src/shared/contracts";
import { parseUnifiedDiff } from "../../src/shared/diff-review";
import { SecureFileTestBroker } from "../support/secure-file-test-broker";

class EventQueue {
  private readonly events: ServerEvent[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(socket: WebSocket) {
    socket.on("message", (data) => {
      const received = JSON.parse(data.toString()) as ServerEvent;
      this.events.push(
        received.type === "runtime.event" ? received.event : received,
      );
      for (const listener of this.listeners) listener();
    });
  }

  async next<T extends ServerEvent>(
    predicate: (event: ServerEvent) => event is T,
  ): Promise<T> {
    const take = (): T | undefined => {
      const index = this.events.findIndex(predicate);
      return index < 0
        ? undefined
        : this.events.splice(index, 1)[0] as T;
    };
    const existing = take();
    if (existing) return existing;
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error("Timed out waiting for the runtime response."));
      }, 6_000);
      const check = (): void => {
        const event = take();
        if (!event) return;
        clearTimeout(timeout);
        this.listeners.delete(check);
        resolve(event);
      };
      this.listeners.add(check);
    });
  }
}

const runtimes: RunningRuntime[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): { root: string; data: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), "inertia-authority-runtime-"));
  const data = join(root, "data");
  const workspace = join(root, "workspace");
  mkdirSync(data);
  mkdirSync(workspace);
  const store = new RuntimeStore(join(data, "inertia.sqlite"), workspace);
  const project = store.createProject("Authority project", workspace);
  store.createConversation(project.id, "Authority chat");
  store.close();
  roots.push(root);
  return { root, data, workspace };
}

function initializeRepository(root: string): void {
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "runtime@example.invalid"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Runtime Test"], { cwd: root });
}

async function connectRuntime(
  data: string,
  workspace: string,
): Promise<{
  socket: WebSocket;
  events: EventQueue;
  projectId: string;
  conversationId: string;
}> {
  const runtime = await startRuntime({
    dataDirectory: data,
    defaultWorkspacePath: workspace,
    enableProviders: false,
    secureFiles: new SecureFileTestBroker(),
  });
  runtimes.push(runtime);
  const socket = new WebSocket(runtime.websocketUrl, {
    origin: "http://localhost:5173",
  });
  const events = new EventQueue(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const welcome = await events.next(
    (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
      event.type === "server.welcome",
  );
  return {
    socket,
    events,
    projectId: welcome.snapshot.activeProjectId!,
    conversationId: welcome.snapshot.activeConversationId!,
  };
}

function send(socket: WebSocket, command: object): void {
  socket.send(JSON.stringify(command));
}

async function replaceWorkspaceRoot(
  workspace: string,
  moved: string,
  outside: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      renameSync(workspace, moved);
      break;
    } catch (error) {
      const code = error instanceof Error && "code" in error
        ? error.code
        : null;
      if (
        process.platform !== "win32"
        || (code !== "EBUSY" && code !== "EPERM")
        || Date.now() >= deadline
      ) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  symlinkSync(
    outside,
    workspace,
    process.platform === "win32" ? "junction" : "dir",
  );
}

describe("runtime secure-file authority lifetime", () => {
  it("rejects a workspace save when its preview root is replaced", async () => {
    const { root, data, workspace } = fixture();
    const moved = join(root, "workspace-moved");
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(workspace, "example.ts"), "inside\n");
    writeFileSync(join(outside, "example.ts"), "outside\n");
    const { socket, events, projectId, conversationId } =
      await connectRuntime(data, workspace);
    const readId = randomUUID();
    send(socket, {
      type: "workspace.file.read",
      requestId: readId,
      payload: { projectId, conversationId, path: "example.ts" },
    });
    const read = await events.next(
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result"
        && event.requestId === readId
        && event.result.kind === "workspace.file",
    );
    if (
      read.result.kind !== "workspace.file"
      || !read.result.file.authorityRef
    ) throw new Error("Expected an authorized workspace preview.");

    await replaceWorkspaceRoot(workspace, moved, outside);
    const writeId = randomUUID();
    send(socket, {
      type: "workspace.file.write",
      requestId: writeId,
      payload: {
        projectId,
        conversationId,
        path: "example.ts",
        content: "replacement\n",
        expectedDigest: read.result.file.contentDigest,
        authorityRef: read.result.file.authorityRef,
      },
    });
    const rejected = await events.next(
      (event): event is Extract<ServerEvent, { type: "request.error" }> =>
        event.type === "request.error" && event.requestId === writeId,
    );
    expect(rejected.message).toMatch(/authorization expired|refresh/i);
    expect(readFileSync(join(moved, "example.ts"), "utf8")).toBe("inside\n");
    expect(readFileSync(join(outside, "example.ts"), "utf8")).toBe("outside\n");
  });

  it("rejects an untracked diff when its discovered root is replaced", async () => {
    const { root, data, workspace } = fixture();
    const moved = join(root, "workspace-moved");
    const outside = join(root, "outside");
    mkdirSync(outside);
    for (const repository of [workspace, outside]) {
      initializeRepository(repository);
      writeFileSync(join(repository, "tracked.ts"), "base\n");
      execFileSync("git", ["add", "tracked.ts"], { cwd: repository });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: repository });
    }
    writeFileSync(join(workspace, "untracked.ts"), "inside\n");
    writeFileSync(join(outside, "untracked.ts"), "OUTSIDE_SENTINEL\n");
    const { socket, events, projectId, conversationId } =
      await connectRuntime(data, workspace);
    const refreshId = randomUUID();
    send(socket, {
      type: "git.workspace.refresh",
      requestId: refreshId,
      payload: { projectId, conversationId },
    });
    const refreshed = await events.next(
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result"
        && event.requestId === refreshId
        && event.result.kind === "git.workspace.status",
    );
    if (refreshed.result.kind !== "git.workspace.status") {
      throw new Error("Expected workspace Git discovery.");
    }
    const authorityRef = refreshed.result.status.repositories.find(
      (repository) => repository.repositoryPath === ".",
    )?.authorityRef;
    if (!authorityRef) throw new Error("Expected repository authority.");

    await replaceWorkspaceRoot(workspace, moved, outside);
    const diffId = randomUUID();
    send(socket, {
      type: "git.workspace.diff",
      requestId: diffId,
      payload: {
        projectId,
        conversationId,
        repositoryPath: ".",
        path: "untracked.ts",
        authorityRef,
      },
    });
    const rejected = await events.next(
      (event): event is Extract<ServerEvent, { type: "request.error" }> =>
        event.type === "request.error" && event.requestId === diffId,
    );
    expect(rejected.message).toMatch(/authorization expired|refresh/i);
    expect(readFileSync(join(outside, "untracked.ts"), "utf8"))
      .toBe("OUTSIDE_SENTINEL\n");
  });

  it("rejects a reversal when its inspected root is replaced", async () => {
    const { root, data, workspace } = fixture();
    const moved = join(root, "workspace-moved");
    const outside = join(root, "outside");
    mkdirSync(outside);
    for (const repository of [workspace, outside]) {
      initializeRepository(repository);
      writeFileSync(join(repository, "example.ts"), "before\n");
      execFileSync("git", ["add", "example.ts"], { cwd: repository });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: repository });
      writeFileSync(join(repository, "example.ts"), "after\n");
    }
    const structured = parseUnifiedDiff((await getUnifiedDiff(workspace)).text);
    const file = structured.files[0]!;
    const hunk = file.hunks[0]!;
    const lineIds = hunk.lines
      .filter((line) => line.kind === "addition" || line.kind === "deletion")
      .map((line) => line.id);
    const { socket, events, projectId, conversationId } =
      await connectRuntime(data, workspace);
    const inspectId = randomUUID();
    send(socket, {
      type: "git.selection.inspect",
      requestId: inspectId,
      payload: {
        projectId,
        conversationId,
        repositoryPath: ".",
        fingerprint: structured.fingerprint,
        filePath: file.path,
        hunkId: hunk.id,
        lineIds,
      },
    });
    const inspected = await events.next(
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result"
        && event.requestId === inspectId
        && event.result.kind === "git.reversal.plan",
    );
    if (
      inspected.result.kind !== "git.reversal.plan"
      || !inspected.result.plan.authorityRef
    ) throw new Error("Expected an authorized reversal plan.");

    await replaceWorkspaceRoot(workspace, moved, outside);
    const revertId = randomUUID();
    send(socket, {
      type: "git.selection.revert",
      requestId: revertId,
      payload: {
        projectId,
        conversationId,
        repositoryPath: ".",
        fingerprint: structured.fingerprint,
        filePath: file.path,
        hunkId: hunk.id,
        lineIds,
        expected: inspected.result.plan.validation,
        authorityRef: inspected.result.plan.authorityRef,
      },
    });
    const rejected = await events.next(
      (event): event is Extract<ServerEvent, { type: "request.error" }> =>
        event.type === "request.error" && event.requestId === revertId,
    );
    expect(rejected.message).toMatch(/authorization expired|refresh/i);
    expect(readFileSync(join(moved, "example.ts"), "utf8")).toBe("after\n");
    expect(readFileSync(join(outside, "example.ts"), "utf8")).toBe("after\n");
  });
});
