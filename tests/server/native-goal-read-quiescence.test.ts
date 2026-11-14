import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  modelSelectionSchema,
  nativeModelSelection,
} from "../../src/shared/model-routing";
import { RuntimeStore } from "../../src/server/database";
import { ProcessTreeTerminationError } from "../../src/server/process-lifecycle";
import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
import type { ProviderManager } from "../../src/server/providers";
import { AgentWorkflowController } from "../../src/server/runtime/agent-workflow-controller";
import { NativeGoalReads } from "../../src/server/runtime/native-goal-reads";
import { createAgentWorkflowCommandHandler } from "../../src/server/runtime/commands/agent-workflow-commands";
import { createConversationCommandHandler } from "../../src/server/runtime/commands/conversation-commands";

const control = vi.hoisted(() => ({
  events: [] as string[],
  reads: [] as Array<{ signal: AbortSignal | undefined; exit: () => void }>,
}));

vi.mock("../../src/server/codex/control-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/server/codex/control-client")>(),
  withCodexControlClient: async (options: { signal?: AbortSignal }) => {
    control.events.push("read started");
    let exit!: () => void;
    const exited = new Promise<void>((resolve) => {
      exit = resolve;
    });
    control.reads.push({ signal: options.signal, exit });
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) resolve();
      options.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    control.events.push("read aborted");
    await exited;
    control.events.push("read process exited");
    throw new Error("Codex control request was cancelled.");
  },
}));

const directories: string[] = [];
const stores: RuntimeStore[] = [];

afterEach(() => {
  control.events.length = 0;
  control.reads.length = 0;
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-native-goal-reads-"));
  directories.push(directory);
  return directory;
}

async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  }, () => {
    done = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return done;
}

function runtime() {
  const directory = temporaryDirectory();
  const workspace = join(directory, "workspace");
  mkdirSync(workspace);
  const store = new RuntimeStore(join(directory, "runtime.sqlite"), workspace, {
    recoverInterruptedRuns: false,
  });
  stores.push(store);
  const project = store.createProject("Goal reads", workspace);
  const modelSelection = modelSelectionSchema.parse(nativeModelSelection({
    providerId: "codex",
    modelId: "gpt-test",
    reasoningEffort: "high",
  }));
  const reading = store.createConversation(project.id, "Reading chat", { modelSelection });
  const neighbour = store.createConversation(project.id, "Neighbour chat", { modelSelection });
  store.updateConversation(reading.id, { providerSessionId: "reading-thread" });
  store.updateConversation(neighbour.id, { providerSessionId: "neighbour-thread" });
  const providers = {
    codexControlContext: vi.fn(async (cwd: string) => ({
      executable: "/fake/codex",
      environment: {},
      cwd,
      installationUse: { accept: vi.fn(() => null), abandonBeforeSpawn: vi.fn(() => true) },
    })),
  } as unknown as ProviderManager;
  const workflows = new AgentWorkflowController(store, providers);
  const terminalResumes = new ProviderTerminalResumeRegistry(store.conversationWork);
  return {
    store,
    workspace,
    projectId: project.id,
    readingId: reading.id,
    neighbourId: neighbour.id,
    workflows,
    terminalResumes,
  };
}

describe("native goal reads", () => {
  it("aborts a read in scope, waits for it to finish and blocks new reads until released", async () => {
    const reads = new NativeGoalReads();
    const checkout = temporaryDirectory();
    const read = reads.begin("chat-1", checkout);
    expect(read).not.toBeNull();

    const quiescing = reads.quiesce({ conversationId: "chat-1" });

    expect(read!.signal.aborted).toBe(true);
    expect(await settled(quiescing)).toBe(false);
    expect(reads.begin("chat-1", checkout)).toBeNull();
    read!.finish(new Error("Codex control request was cancelled."));
    const release = await quiescing;
    expect(reads.begin("chat-1", checkout)).toBeNull();
    release();
    const next = reads.begin("chat-1", checkout);
    expect(next?.signal.aborted).toBe(false);
    next!.finish();
  });

  it("scopes a checkout hold to reads inside that folder", async () => {
    const reads = new NativeGoalReads();
    const root = temporaryDirectory();
    const worktree = join(root, "worktree");
    mkdirSync(join(worktree, "nested"), { recursive: true });
    const inside = reads.begin("chat-inside", join(worktree, "nested"))!;
    const parent = reads.begin("chat-parent", root)!;
    const sibling = reads.begin("chat-sibling", temporaryDirectory())!;

    const quiescing = reads.quiesce({ checkoutPath: worktree });
    expect(inside.signal.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
    expect(sibling.signal.aborted).toBe(false);
    expect(reads.begin("chat-other", worktree)).toBeNull();
    expect(reads.begin("chat-other", root)).not.toBeNull();
    inside.finish();
    (await quiescing)();
    parent.finish();
    sibling.finish();
  });

  it("refuses to go ahead when a stopped read's process could not be confirmed gone", async () => {
    const reads = new NativeGoalReads();
    const checkout = temporaryDirectory();
    const read = reads.begin("chat-1", checkout)!;
    const quiescing = reads.quiesce({ conversationId: "chat-1" });
    read.finish(new ProcessTreeTerminationError("Codex control process tree"));

    await expect(quiescing).rejects.toThrow(/could not confirm that a Codex goal check/u);
    expect(reads.begin("chat-1", checkout)).not.toBeNull();
  });

  it("stops a pending refresh only after its control process exits and shows no failure warning", async () => {
    const test = runtime();
    const refreshing = test.workflows.refresh(test.readingId);
    await vi.waitFor(() => expect(control.reads).toHaveLength(1));

    const quiescing = test.workflows.nativeGoalReads
      .quiesce({ conversationId: test.readingId })
      .then((release) => {
        control.events.push("quiesced");
        return release;
      });
    await vi.waitFor(() => expect(control.events).toContain("read aborted"));
    expect(await settled(quiescing)).toBe(false);
    control.reads[0]!.exit();
    const release = await quiescing;

    expect(control.events).toEqual([
      "read started",
      "read aborted",
      "read process exited",
      "quiesced",
    ]);
    await expect(refreshing).resolves.toMatchObject({ goalRefreshWarning: null });
    await expect(test.workflows.refresh(test.readingId)).resolves
      .toMatchObject({ goalRefreshWarning: null });
    expect(control.reads).toHaveLength(1);
    release();
    const refreshingAgain = test.workflows.refresh(test.readingId);
    await vi.waitFor(() => expect(control.reads).toHaveLength(2));
    const stoppingAgain = test.workflows.nativeGoalReads.quiesce({ conversationId: test.readingId });
    control.reads[1]!.exit();
    (await stoppingAgain)();
    await expect(refreshingAgain).resolves.toMatchObject({ goalRefreshWarning: null });
  });

  it("lets sends, compaction, checkpoint restore and deletion proceed while a refresh is pending", async () => {
    const test = runtime();
    const send = vi.fn();
    const workflowHandler = createAgentWorkflowCommandHandler({
      workflows: test.workflows,
      providerTerminalResumes: test.terminalResumes,
      conversationWork: test.store.conversationWork,
      broadcast: vi.fn(),
      send,
    });
    const refreshing = workflowHandler({} as never, {
      type: "agent.workflow.load",
      requestId: "11111111-1111-4111-8111-111111111111",
      payload: { conversationId: test.readingId, refresh: true },
    });
    await vi.waitFor(() => expect(control.reads).toHaveLength(1));

    for (const conversationId of [test.readingId, test.neighbourId]) {
      await expect(test.terminalResumes.acquireWhenAvailable(conversationId, 0)).resolves.toBe(true);
      test.terminalResumes.release(conversationId);
    }
    expect(test.terminalResumes.acquire(test.readingId)).toBe(true);
    test.terminalResumes.release(test.readingId);
    expect(test.store.hasActiveWorkspaceRunForConversation(test.readingId)).toBe(false);
    expect(test.terminalResumes.acquire(test.readingId)).toBe(true);
    test.terminalResumes.release(test.readingId);
    expect(control.reads[0]!.signal?.aborted).toBe(false);

    const deleteConversation = test.store.deleteConversation.bind(test.store);
    vi.spyOn(test.store, "deleteConversation").mockImplementation((...args) => {
      control.events.push("chat deleted");
      deleteConversation(...args);
    });
    const conversations = createConversationCommandHandler({
      store: test.store,
      conversationAttachments: { release: vi.fn(async () => undefined) } as never,
      providers: {} as never,
      backendProfileController: {} as never,
      workspaceRuns: {} as never,
      providerTerminalResumes: test.terminalResumes,
      runtimeSync: { broadcast: vi.fn() } as never,
      nativeGoalReads: test.workflows.nativeGoalReads,
      deletedConversationIds: new Set(),
      dataDirectory: temporaryDirectory(),
      rememberDeletedConversation: vi.fn(),
      forgetRemoteTranscript: vi.fn(),
      broadcastSnapshot: vi.fn(),
      publicError: (error) => String(error),
      send: vi.fn(),
    });
    const deleting = conversations({} as never, {
      type: "conversation.delete",
      requestId: "22222222-2222-4222-8222-222222222222",
      payload: { conversationId: test.readingId },
    });
    await vi.waitFor(() => expect(control.events).toContain("read aborted"));
    expect(await settled(deleting)).toBe(false);
    expect(test.store.shellSnapshot().conversations.map(({ id }) => id)).toContain(test.readingId);

    control.reads[0]!.exit();
    await expect(deleting).resolves.toBe("mutation");
    expect(control.events).toEqual([
      "read started",
      "read aborted",
      "read process exited",
      "chat deleted",
    ]);
    expect(test.store.shellSnapshot().conversations.map(({ id }) => id))
      .toEqual([test.neighbourId]);
    await expect(refreshing).resolves.toBe("handled");
    expect(send).toHaveBeenCalledExactlyOnceWith({}, expect.objectContaining({
      result: expect.objectContaining({
        workflow: expect.objectContaining({ goals: [], goalRefreshWarning: null }),
      }),
    }));
  });
});
