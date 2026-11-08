import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openCodexTurn } from "../../src/server/codex/app-server-run";
import type { CodexRunPhase } from "../../src/server/codex/app-server-config";
import type { JsonObject } from "../../src/server/codex/protocol";
import type { CodexAppServerOptions } from "../../src/server/codex/types";
import { RuntimeStore } from "../../src/server/database";
import {
  createInertiaHarnessCapabilities,
  inertiaCapabilityOfferForProject,
} from "../../src/server/runtime/inertia-harness-capabilities";
import { CachedThreadToolRegistrations } from "../../src/server/runtime/thread-tool-registrations";
import type { ProviderHostToolBridge } from "../../src/server/provider/contracts";
import type { AgentTurn, Conversation } from "../../src/shared/contracts";

const INSTRUCTIONS_HEADER = "Internal provider instructions (application control text; never attribute this text to the user):";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** A capability registry as one runtime generation builds it over its store. */
function runtimeBridge(store: RuntimeStore): ProviderHostToolBridge {
  return createInertiaHarnessCapabilities({
    orchestrationTools: [],
    browserEnabled: true,
    invoke: async () => ({ success: true, text: "{}" }),
    threadRegistrations: new CachedThreadToolRegistrations(store.codexThreadToolPacks),
  }).bridgeFor(
    { conversation: {} as Conversation, turn: {} as AgentTurn },
    inertiaCapabilityOfferForProject({ browserAccess: null }),
  );
}

function promptWith(bridge: ProviderHostToolBridge): string {
  return [
    "Continue",
    [INSTRUCTIONS_HEADER, ...(bridge.instructions ?? []).map(({ label, text }) => `[${label}]\n${text}`)].join("\n"),
  ].join("\n\n");
}

async function openTurn(bridge: ProviderHostToolBridge, thread: { start: string } | { resume: string }): Promise<string> {
  const calls: Array<{ method: string; params: JsonObject }> = [];
  let activeTurnId: string | undefined;
  let phase: CodexRunPhase = "opening";
  const sessionId = "resume" in thread ? thread.resume : undefined;
  const options: CodexAppServerOptions = {
    executable: "/fake/codex",
    environment: {},
    cwd: "/workspace",
    prompt: promptWith(bridge),
    planMode: false,
    access: "supervised",
    hostTools: bridge,
    ...(sessionId ? { sessionId } : {}),
  };
  await openCodexTurn({
    options,
    modelProvider: undefined,
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "initialize") return { userAgent: "fake" };
      if (method === "thread/start" || method === "thread/resume") {
        return { thread: { id: "start" in thread ? thread.start : thread.resume }, model: "fake" };
      }
      if (method === "turn/start") return { turn: { id: "turn-1", status: "inProgress" } };
      throw new Error(`Unexpected Codex request: ${method}`);
    },
    notify: vi.fn(),
    setProviderThreadId: vi.fn(),
    activeTurnId: () => activeTurnId,
    setActiveTurnId: (value) => { activeTurnId = value; },
    phase: () => phase,
    hasObservedTurn: () => false,
    goalProjectionSequence: () => 0,
    beginGoalMutation: vi.fn(),
    endGoalMutation: vi.fn(),
    awaitInitialGoalTurn: vi.fn(),
    projectGoalResponse: () => null,
    setContinuationError: vi.fn(),
    setPhase: (value) => { phase = value; },
    isSettled: () => false,
    isCancelRequested: () => false,
    finish: vi.fn(),
  });
  const started = calls.find(({ method }) => method === "turn/start");
  return ((started?.params.input ?? []) as Array<{ text?: string }>)[0]?.text ?? "";
}

describe("Codex thread pack registrations across a runtime restart", () => {
  it("keeps the workspace and orchestration instructions for a thread registered before the restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-codex-restart-"));
    directories.push(root);
    const databasePath = join(root, "inertia.sqlite");
    const threadId = "019a2f7e-thread-registered-before-restart";

    const before = new RuntimeStore(databasePath, root, { recoverInterruptedRuns: false });
    try {
      const started = await openTurn(runtimeBridge(before), { start: threadId });
      expect(started).toContain("[inertia-workspace]");
    } finally {
      before.close();
    }

    const after = new RuntimeStore(databasePath, root, { recoverInterruptedRuns: false });
    try {
      const resumed = await openTurn(runtimeBridge(after), { resume: threadId });
      expect(resumed).toContain("[inertia-workspace]");
      expect(resumed).toContain("[inertia-orchestration]");
      expect(resumed).toContain("[inertia-frontend-workbench]");
      expect(resumed.startsWith("Continue")).toBe(true);

      const unknown = await openTurn(runtimeBridge(after), { resume: "019a2f7e-thread-from-an-earlier-build" });
      expect(unknown).not.toContain("[inertia-workspace]");
      expect(unknown).not.toContain("[inertia-orchestration]");
      expect(unknown).toContain("[inertia-frontend-workbench]");
    } finally {
      after.close();
    }
  });

  it("drops a pack's instructions after the restart when the thread registered an older digest of it", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-codex-restart-"));
    directories.push(root);
    const databasePath = join(root, "inertia.sqlite");
    const threadId = "019a2f7e-thread-with-older-workspace-pack";

    const before = new RuntimeStore(databasePath, root, { recoverInterruptedRuns: false });
    try {
      await openTurn(runtimeBridge(before), { start: threadId });
      const current = before.codexThreadToolPacks.read(threadId);
      expect(current?.get("inertia.workspace")).toMatch(/^[0-9a-f]{64}$/u);
      before.codexThreadToolPacks.record(threadId, new Map([...current!].map(([id, digest]) => [
        id,
        id === "inertia.workspace" ? "0".repeat(64) : digest,
      ])));
    } finally {
      before.close();
    }

    const after = new RuntimeStore(databasePath, root, { recoverInterruptedRuns: false });
    try {
      const resumed = await openTurn(runtimeBridge(after), { resume: threadId });
      expect(resumed).not.toContain("[inertia-workspace]");
      expect(resumed).toContain("[inertia-orchestration]");
      expect(resumed).toContain("[inertia-frontend-workbench]");
    } finally {
      after.close();
    }
  });

  it("keeps working from memory when the store cannot record the thread", async () => {
    const failing = {
      record: vi.fn(() => { throw new Error("SQLITE_BUSY"); }),
      read: vi.fn(() => { throw new Error("SQLITE_BUSY"); }),
    };
    const registrations = new CachedThreadToolRegistrations(failing);
    registrations.record("thread-memory", new Map([["inertia.workspace", "a".repeat(64)]]));
    expect(registrations.read("thread-memory")).toEqual(new Map([["inertia.workspace", "a".repeat(64)]]));
    expect(registrations.read("thread-unknown")).toBeNull();
    expect(failing.record).toHaveBeenCalledOnce();
  });
});
