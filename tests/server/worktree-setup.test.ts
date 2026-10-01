import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { inspectProjectIdentity } from "../../src/server/project-identity";
import { ConversationCreationService, type ConversationCreationDependencies } from "../../src/server/runtime/conversation-creation-service";
import { WorktreeSetupController } from "../../src/server/runtime/worktree-setup-controller";
import { RestrictedCliError, type runRestrictedCli } from "../../src/server/restricted-cli-runner";
import { defaultProjectPreferences, projectPreferencesSchema } from "../../src/shared/project-preferences";
import { modelSelectionSchema, providerNativeModelSelection } from "../../src/shared/model-routing";
import { removeTemporaryDirectory } from "../helpers/temporary-directory";
import { resolveNativeModelRoute } from "./model-route-fixture";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function fixture(script: string, run?: typeof runRestrictedCli) {
  const root = mkdtempSync(join(tmpdir(), "inertia-worktree-setup-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  execFileSync("git", ["init", "-b", "main", workspace]);
  writeFileSync(join(workspace, "tracked.txt"), "preserve original\n");
  execFileSync("git", ["-C", workspace, "add", "."]);
  execFileSync("git", ["-C", workspace, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Initial"]);
  const databasePath = join(root, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspace);
  const project = store.createProject("Setup project", workspace, await inspectProjectIdentity(workspace));
  const action = { id: randomUUID(), name: "Install dependencies", executable: process.execPath, args: ["-e", script] };
  store.updateProject(project.id, { preferences: { ...defaultProjectPreferences(), actions: [action], worktreeSetupActionId: action.id } });
  const abort = new AbortController();
  const tasks: Promise<unknown>[] = [];
  const setup = new WorktreeSetupController({ store, signal: abort.signal, broadcastSnapshot: vi.fn(), run,
    track: (operation) => { const task = operation(); tasks.push(task); return task; } });
  const creation = new ConversationCreationService({ store, dataDirectory: join(root, "data"), worktreeSetups: setup, broadcastSnapshot: vi.fn(),
    providers: { resolveModelRoute: resolveNativeModelRoute } as ConversationCreationDependencies["providers"],
    backendProfileController: { validateSelection: (value: unknown) => value } as ConversationCreationDependencies["backendProfileController"],
    workspaceRuns: { trackSourceControl: async (...args) => await args[5]() },
  });
  const create = (useWorktree = true, worktreePath?: string) => creation.create({ projectId: project.id, title: "New chat", useWorktree,
    modelSelection: modelSelectionSchema.parse(providerNativeModelSelection({ providerId: "codex", modelId: "gpt-test" })), ...(worktreePath ? { worktreePath } : {}) }, randomUUID());
  cleanups.push(async () => { abort.abort(); await Promise.allSettled(tasks); store.close(); await removeTemporaryDirectory(root); });
  return { store, setup, create, workspace, action, project, databasePath };
}

describe("worktree setup", () => {
  it("is opt-in and rejects an unknown setup action", () => {
    const old = { ...defaultProjectPreferences(), worktreeSetupActionId: undefined };
    expect(projectPreferencesSchema.parse(old).worktreeSetupActionId).toBeNull();
    expect(projectPreferencesSchema.safeParse({ ...old, worktreeSetupActionId: randomUUID() }).success).toBe(false);
  });

  it("runs once in the new owned checkout, never in the original or a reused checkout", async () => {
    const f = await fixture('require("fs").appendFileSync("setup-ran.txt", "once\\n"); console.log("Dependencies ready")');
    const local = await f.create(false);
    expect(f.setup.read(local.id).summary).toBeNull();
    const chat = await f.create();
    await f.setup.waitUntilReady(chat.id);
    expect(f.setup.read(chat.id)).toMatchObject({ summary: { status: "succeeded", attempt: 1 }, output: "Dependencies ready" });
    expect(existsSync(join(f.workspace, "setup-ran.txt"))).toBe(false);
    expect(readFileSync(join(chat.worktreePath!, "setup-ran.txt"), "utf8")).toBe("once\n");
    const reused = await f.create(false, chat.worktreePath!);
    f.setup.initialize(chat.id);
    f.setup.initialize(reused.id);
    expect(f.setup.read(reused.id).summary?.status).toBe("succeeded");
    expect(readFileSync(join(chat.worktreePath!, "setup-ran.txt"), "utf8")).toBe("once\n");
  });

  it("blocks prompts and overlapping work until setup finishes, including reused chats", async () => {
    let finish!: () => void;
    const runner = vi.fn<typeof runRestrictedCli>(() => new Promise((resolve) => { finish = () => resolve({ stdout: "", stderr: "" }); }));
    const f = await fixture("", runner);
    const chat = await f.create();
    await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
    expect(() => f.store.worktreeSetups.assertReady(chat.id)).toThrow(/Finish worktree setup/u);
    expect(f.store.conversationWork.reserve(chat.id)).toBe(false);
    const reused = await f.create(false, chat.worktreePath!);
    expect(() => f.store.worktreeSetups.assertReady(reused.id)).toThrow(/Finish worktree setup/u);
    expect(() => f.setup.skip(chat.id)).toThrow(/Stop setup/u);
    expect(() => f.setup.retry(chat.id)).toThrow(/still stopping/u);
    finish();
    await f.setup.waitUntilReady(chat.id);
    expect(() => f.store.worktreeSetups.assertReady(reused.id)).not.toThrow();
    expect(f.store.conversationWork.reserve(chat.id)).toBe(true);
    f.store.conversationWork.release(chat.id);
  });

  it("keeps failed checkouts and retries the captured action even after preferences change", async () => {
    const f = await fixture('const fs=require("fs");if(!fs.existsSync("attempt.txt")){fs.writeFileSync("attempt.txt","keep");console.error("Install failed");process.exit(1)} console.log("Recovered")');
    const chat = await f.create();
    await expect(f.setup.waitUntilReady(chat.id)).rejects.toThrow(/Finish worktree setup/u);
    expect(f.setup.read(chat.id)).toMatchObject({ summary: { status: "failed" }, output: "Install failed" });
    expect(readFileSync(join(chat.worktreePath!, "attempt.txt"), "utf8")).toBe("keep");
    f.store.updateProject(f.project.id, { preferences: defaultProjectPreferences() });
    f.setup.retry(chat.id);
    await f.setup.waitUntilReady(chat.id);
    expect(f.setup.read(chat.id)).toMatchObject({ summary: { status: "succeeded", attempt: 2 }, output: "Recovered" });
  });

  it("can stop a running setup, retain its output, then explicitly continue", async () => {
    const f = await fixture('console.log("Installing dependencies");setInterval(()=>{},1000)');
    const chat = await f.create();
    await vi.waitFor(() => expect(f.store.hasRecordedActiveWorkspaceRun()).toBe(true));
    f.setup.cancel(chat.id);
    await expect(f.setup.waitUntilReady(chat.id)).rejects.toThrow();
    expect(f.setup.read(chat.id).summary?.status).toBe("cancelled");
    expect(existsSync(chat.worktreePath!)).toBe(true);
    f.setup.skip(chat.id);
    expect(f.setup.read(chat.id).summary?.status).toBe("skipped");
    expect(() => f.store.worktreeSetups.assertReady(chat.id)).not.toThrow();
    expect(f.store.hasActiveWorkspaceRunForConversation(chat.id)).toBe(false);
  });

  it("redacts credentials and bounds persisted output", async () => {
    const f = await fixture('console.log("api_key=private-secret-123456789"); console.log("x".repeat(20000)); process.exit(1)');
    const chat = await f.create();
    await expect(f.setup.waitUntilReady(chat.id)).rejects.toThrow();
    const output = f.setup.read(chat.id).output;
    expect(output).not.toContain("private-secret");
    expect(output).toContain("[redacted]");
    expect(output.length).toBeLessThanOrEqual(16_384);
  });

  it("quarantines cleanup failures and refuses both retry and continue", async () => {
    const runner = vi.fn<typeof runRestrictedCli>().mockRejectedValue(new RestrictedCliError("cleanup", "Unconfirmed process tree"));
    const f = await fixture("", runner);
    const chat = await f.create();
    await expect(f.setup.waitUntilReady(chat.id)).rejects.toThrow();
    expect(f.setup.read(chat.id).summary?.detail).toContain("Restart Inertia");
    expect(() => f.setup.skip(chat.id)).toThrow(/Stop setup/u);
    expect(() => f.setup.retry(chat.id)).toThrow(/still stopping/u);
    expect(f.store.conversationWork.reserve(chat.id)).toBe(false);
  });

  it("recovers an interrupted attempt without automatically rerunning it", async () => {
    const f = await fixture('console.log("ready")');
    const chat = await f.create();
    await f.setup.waitUntilReady(chat.id);
    f.store.worktreeSetups.update(chat.id, { ...f.setup.read(chat.id).summary!, status: "running", finishedAt: null });
    const reopened = new RuntimeStore(f.databasePath, f.workspace);
    try {
      expect(reopened.worktreeSetups.read(chat.id)?.summary.status).toBe("interrupted");
      expect(() => reopened.worktreeSetups.assertReady(chat.id)).toThrow();
      expect(reopened.worktreeSetups.read(chat.id)?.summary.attempt).toBe(1);
    } finally { reopened.close(); }
  });
});
