import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { expect, it } from "vitest";
import type { ServerEvent } from "../../src/shared/contracts";
import { defaultProjectPreferences } from "../../src/shared/project-preferences";
import { RuntimeStore } from "../../src/server/database";
import { inspectProjectIdentity } from "../../src/server/project-identity";
import { startTestRuntime } from "../support/test-runtime";
import { removeTemporaryDirectory } from "../helpers/temporary-directory";

it("wires saved setup actions through the ordinary runtime creation command", async () => {
  const root = mkdtempSync(join(tmpdir(), "inertia-setup-runtime-"));
  const workspace = join(root, "workspace");
  const data = join(root, "data");
  mkdirSync(workspace);
  mkdirSync(data, { mode: 0o700 });
  execFileSync("git", ["init", "-b", "main", workspace]);
  writeFileSync(join(workspace, "setup.cjs"), 'console.log("Checkout ready")');
  execFileSync("git", ["-C", workspace, "add", "."]);
  execFileSync("git", ["-C", workspace, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Initial"]);
  const store = new RuntimeStore(join(data, "inertia.sqlite"), workspace);
  const project = store.createProject("Setup runtime", workspace, await inspectProjectIdentity(workspace));
  const action = { id: randomUUID(), name: "Prepare", executable: process.execPath, args: ["setup.cjs"] };
  store.updateProject(project.id, { preferences: { ...defaultProjectPreferences(), actions: [action], worktreeSetupActionId: action.id } });
  store.close();
  const runtime = await startTestRuntime({ dataDirectory: data, defaultWorkspacePath: workspace, enableProviders: false,
    runtimeGenerationId: `${randomUUID()}:1`, systemBootId: `test:${randomUUID()}`,
  });
  const socket = new WebSocket(runtime.websocketUrl, { origin: "http://localhost:5173" });
  const request = async (command: object): Promise<ServerEvent> => await new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const receive = (data: WebSocket.RawData): void => {
      const event = JSON.parse(data.toString()) as ServerEvent;
      if (!("requestId" in event) || event.requestId !== requestId) return;
      clearTimeout(timer);
      socket.off("message", receive);
      resolve(event);
    };
    const timer = setTimeout(() => { socket.off("message", receive); reject(new Error("Setup runtime request timed out")); }, 15_000);
    socket.on("message", receive);
    socket.send(JSON.stringify({ ...command, requestId }));
  });
  try {
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const created = await request({ type: "conversation.create", payload: { projectId: project.id, title: "Prepared chat", useWorktree: true, activate: false } });
    expect(created).toMatchObject({ type: "request.result", result: { kind: "conversation.created" } });
    if (created.type !== "request.result" || created.result.kind !== "conversation.created") throw new Error("Chat was not created");
    let result: ServerEvent;
    do {
      result = await request({ type: "worktree.setup.wait", payload: { conversationId: created.result.conversationId } });
    } while (result.type === "request.result" && result.result.kind === "worktree.setup" && ["pending", "running"].includes(result.result.summary?.status ?? ""));
    expect(result).toMatchObject({ type: "request.result", result: { kind: "worktree.setup", summary: { status: "succeeded" }, output: "Checkout ready" } });
  } finally {
    socket.terminate();
    await runtime.close();
    await removeTemporaryDirectory(root);
  }
});
