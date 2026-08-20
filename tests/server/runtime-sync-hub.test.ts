import { describe, expect, it, vi } from "vitest";

import type {
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlan,
  AppSnapshot,
  ProviderMaintenanceOperation,
  ServerEvent,
} from "../../src/shared/contracts";
import { RuntimeSequencer } from "../../src/server/runtime-sequencing";
import { RuntimeSyncHub } from "../../src/server/runtime/runtime-sync-hub";

const GENERATION = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONVERSATION_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function snapshot(sync: AppSnapshot["sync"]): AppSnapshot {
  return {
    projects: [],
    conversations: [],
    runs: [],
    providers: [],
    backendProfiles: [],
    backendDefaults: [],
    settings: {} as AppSnapshot["settings"],
    activeProjectId: null,
    activeConversationId: null,
    sync,
  };
}

function approval(): AgentApprovalRequest {
  return {
    id: "approval",
    providerId: "codex",
    conversationId: CONVERSATION_A,
    runId: "run",
    turnId: "turn",
    kind: "command",
    title: "Run check",
    detail: null,
    command: "npm test",
    cwd: "/workspace",
    reason: null,
    networkScope: null,
    permissionRoots: [],
    availableDecisions: ["approve", "deny"],
  };
}

function inputRequest(): AgentInputRequest {
  return {
    id: "input",
    providerId: "codex",
    conversationId: CONVERSATION_A,
    runId: "run",
    turnId: "turn",
    questions: [{
      id: "question",
      header: "Choice",
      question: "Continue?",
      isOther: false,
      isSecret: false,
      allowMultiple: false,
      options: [{ id: "yes", label: "Yes", description: "Continue." }],
    }],
    autoResolutionMs: null,
  };
}

function plan(): AgentPlan {
  return {
    conversationId: CONVERSATION_A,
    runId: "run",
    turnId: "turn",
    explanation: null,
    steps: [{ step: "Inspect", status: "inProgress" }],
  };
}

function maintenanceOperation(): ProviderMaintenanceOperation {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    providerId: "claude",
    status: "running",
    startedAt: "2026-07-27T10:00:00.000Z",
    finishedAt: null,
    beforeVersion: "1.0.0",
    afterVersion: null,
    targetVersion: "2.0.0",
    message: "Updating provider.",
    output: null,
    outputTruncated: false,
  };
}

function fixture() {
  const events = new Map<string, ServerEvent[]>();
  const send = (socket: string, event: ServerEvent): void => {
    const current = events.get(socket) ?? [];
    current.push(event);
    events.set(socket, current);
  };
  const hub = new RuntimeSyncHub(
    send,
    new RuntimeSequencer({ runtimeGeneration: GENERATION }),
  );
  return { events, send: vi.fn(send), hub };
}

describe("runtime sync hub", () => {
  it("does not own a socket when fresh hydration fails", () => {
    const runtime = fixture();
    expect(() => runtime.hub.connect("broken", { kind: "none" }, {
      beforeFreshSnapshot: () => {
        throw new Error("flush failed");
      },
      snapshot,
      approvals: [],
      inputs: [],
      plans: [],
    })).toThrow("flush failed");
    expect(runtime.hub.connectionCount).toBe(0);
    expect(runtime.events.has("broken")).toBe(false);
  });

  it("hydrates a fresh connection in order and embeds the authoritative cursor", () => {
    const runtime = fixture();
    const beforeFreshSnapshot = vi.fn();
    runtime.hub.connect("fresh", { kind: "none" }, {
      beforeFreshSnapshot,
      snapshot,
      approvals: [approval()],
      inputs: [inputRequest()],
      plans: [plan()],
    });

    const events = runtime.events.get("fresh")!;
    expect(events.map(({ type }) => type)).toEqual([
      "server.welcome",
      "agent.approval.requested",
      "agent.input.requested",
      "agent.plan.updated",
      "runtime.sync.completed",
    ]);
    const welcome = events[0] as Extract<ServerEvent, { type: "server.welcome" }>;
    expect(welcome.snapshot.sync).toEqual(welcome.sync);
    expect(welcome.sync).toEqual({
      runtimeGeneration: GENERATION,
      latestSequence: 0,
    });
    expect(beforeFreshSnapshot).toHaveBeenCalledTimes(1);
    expect(runtime.hub.connectionCount).toBe(1);
  });

  it("binds detached hydration and live delivery to its claimed conversation", () => {
    const runtime = fixture();
    const fullSnapshot = snapshot(undefined);
    fullSnapshot.projects = [
      { id: "project-a", name: "A" },
      { id: "project-b", name: "B" },
    ] as AppSnapshot["projects"];
    fullSnapshot.conversations = [
      { id: CONVERSATION_A, projectId: "project-a", title: "A" },
      { id: CONVERSATION_B, projectId: "project-b", title: "B secret" },
    ] as AppSnapshot["conversations"];
    const otherApproval = {
      ...approval(),
      id: "approval-b",
      conversationId: CONVERSATION_B,
    };
    const otherInput = {
      ...inputRequest(),
      id: "input-b",
      conversationId: CONVERSATION_B,
    };
    const otherPlan = { ...plan(), conversationId: CONVERSATION_B };

    runtime.hub.connect("detached", { kind: "none" }, {
      snapshot: () => fullSnapshot,
      approvals: [approval(), otherApproval],
      inputs: [inputRequest(), otherInput],
      plans: [plan(), otherPlan],
    }, {
      kind: "detached-chat",
      conversationId: CONVERSATION_A,
      clientId: "window-1",
    });

    const hydrated = runtime.events.get("detached")!;
    const welcome = hydrated[0] as Extract<
      ServerEvent,
      { type: "server.welcome" }
    >;
    expect(welcome.snapshot.conversations.map(({ id }) => id)).toEqual([
      CONVERSATION_A,
    ]);
    expect(JSON.stringify(hydrated)).not.toContain(CONVERSATION_B);
    expect(hydrated.map(({ type }) => type)).toEqual([
      "server.welcome",
      "agent.approval.requested",
      "agent.input.requested",
      "agent.plan.updated",
      "runtime.sync.completed",
    ]);

    runtime.hub.setConversationSubscription(
      "detached",
      "secondary",
      CONVERSATION_B,
    );
    hydrated.length = 0;
    runtime.hub.broadcast({
      type: "agent.text",
      conversationId: CONVERSATION_B,
      runId: "run-b",
      turnId: "turn-b",
      text: "secret-b",
    });
    runtime.hub.broadcast({
      type: "agent.text",
      conversationId: CONVERSATION_A,
      runId: "run-a",
      turnId: "turn-a",
      text: "visible-a",
    });
    expect(hydrated[0]).toMatchObject({ type: "runtime.cursor" });
    expect(hydrated[1]).toMatchObject({
      type: "runtime.event",
      event: { type: "agent.text", text: "visible-a" },
    });
    expect(JSON.stringify(hydrated)).not.toContain("secret-b");
  });

  it("owns a fresh socket before sending welcome so an immediate disconnect is not leaked", () => {
    let hub: RuntimeSyncHub<string>;
    const events: ServerEvent[] = [];
    hub = new RuntimeSyncHub((socket, event) => {
      events.push(event);
      if (event.type === "server.welcome") hub.disconnect(socket);
    });

    hub.connect("immediate", { kind: "none" }, {
      snapshot,
      approvals: [],
      inputs: [],
      plans: [],
    });

    expect(events[0]?.type).toBe("server.welcome");
    expect(hub.connectionCount).toBe(0);
  });

  it("projects detail events to subscriptions while advancing every client cursor", () => {
    const runtime = fixture();
    for (const [socket, conversationId] of [
      ["a", CONVERSATION_A],
      ["b", CONVERSATION_B],
    ] as const) {
      runtime.hub.connect(socket, {
        kind: "resume",
        runtimeGeneration: GENERATION,
        afterSequence: 0,
        conversationIds: [conversationId],
      }, {
        snapshot,
        approvals: [],
        inputs: [],
        plans: [],
      });
    }
    runtime.events.get("a")!.length = 0;
    runtime.events.get("b")!.length = 0;

    runtime.hub.broadcast({
      type: "agent.text",
      conversationId: CONVERSATION_A,
      runId: "run",
      turnId: "turn",
      text: "private-a",
    });

    expect(runtime.events.get("a")?.[0]).toMatchObject({
      type: "runtime.event",
      event: { type: "agent.text", text: "private-a" },
    });
    expect(runtime.events.get("b")?.[0]).toMatchObject({
      type: "runtime.cursor",
      sync: { latestSequence: 1 },
    });
    expect(JSON.stringify(runtime.events.get("b"))).not.toContain("private-a");

    runtime.hub.setConversationSubscription(
      "b",
      "secondary",
      CONVERSATION_A,
    );
    runtime.events.get("b")!.length = 0;
    runtime.hub.broadcast({
      type: "agent.text",
      conversationId: CONVERSATION_B,
      runId: "run",
      turnId: "turn",
      text: "still-visible-b",
    });
    runtime.hub.broadcast({
      type: "agent.text",
      conversationId: CONVERSATION_A,
      runId: "run",
      turnId: "turn",
      text: "now-visible",
    });
    expect(runtime.events.get("b")?.[0]).toMatchObject({
      type: "runtime.event",
      event: { type: "agent.text", text: "still-visible-b" },
    });
    expect(runtime.events.get("b")?.[1]).toMatchObject({
      type: "runtime.event",
      sync: { latestSequence: 3 },
      event: { type: "agent.text", text: "now-visible" },
    });

    runtime.hub.setConversationSubscription(
      "b",
      "primary",
      CONVERSATION_C,
    );
    runtime.events.get("b")!.length = 0;
    runtime.hub.broadcast({
      type: "agent.text",
      conversationId: CONVERSATION_B,
      runId: "run",
      turnId: "turn",
      text: "evicted-b",
    });
    runtime.hub.broadcast({
      type: "agent.text",
      conversationId: CONVERSATION_C,
      runId: "run",
      turnId: "turn",
      text: "visible-c",
    });
    expect(runtime.events.get("b")?.[0]).toMatchObject({
      type: "runtime.cursor",
      sync: { latestSequence: 4 },
    });
    expect(runtime.events.get("b")?.[1]).toMatchObject({
      type: "runtime.event",
      sync: { latestSequence: 5 },
      event: { type: "agent.text", text: "visible-c" },
    });
  });

  it("replays a Git completion published after the original socket disconnects", () => {
    const runtime = fixture();
    runtime.hub.connect("original", { kind: "none" }, {
      snapshot,
      approvals: [],
      inputs: [],
      plans: [],
    });
    runtime.hub.disconnect("original");

    runtime.hub.broadcast({
      type: "workspace.git.invalidated",
      requestId: "55555555-5555-4555-8555-555555555555",
      projectId: "66666666-6666-4666-8666-666666666666",
      conversationId: CONVERSATION_A,
    });
    runtime.hub.connect("replacement", {
      kind: "resume",
      runtimeGeneration: GENERATION,
      afterSequence: 0,
      conversationIds: [],
    }, {
      snapshot,
      approvals: [],
      inputs: [],
      plans: [],
    });

    expect(runtime.events.get("replacement")).toMatchObject([
      {
        type: "runtime.resumed",
        sync: { latestSequence: 1 },
      },
      {
        type: "runtime.event",
        sync: { latestSequence: 1 },
        scope: { kind: "shell" },
        event: {
          type: "workspace.git.invalidated",
          requestId: "55555555-5555-4555-8555-555555555555",
        },
      },
      {
        type: "runtime.sync.completed",
        sync: { latestSequence: 1 },
      },
    ]);
  });

  it("removes a closed secondary pane before subscribing its replacement", () => {
    const runtime = fixture();
    runtime.hub.connect("split", {
      kind: "resume",
      runtimeGeneration: GENERATION,
      afterSequence: 0,
      conversationIds: [CONVERSATION_A, CONVERSATION_B],
    }, {
      snapshot,
      approvals: [],
      inputs: [],
      plans: [],
    });
    runtime.events.get("split")!.length = 0;

    runtime.hub.setConversationSubscription(
      "split",
      "primary",
      CONVERSATION_A,
    );
    runtime.hub.setConversationSubscription("split", "secondary", null);
    runtime.hub.setConversationSubscription(
      "split",
      "secondary",
      CONVERSATION_C,
    );

    for (const [conversationId, text] of [
      [CONVERSATION_A, "still-visible-a"],
      [CONVERSATION_B, "closed-b"],
      [CONVERSATION_C, "visible-c"],
    ] as const) {
      runtime.hub.broadcast({
        type: "agent.text",
        conversationId,
        runId: "run",
        turnId: "turn",
        text,
      });
    }

    expect(runtime.events.get("split")).toMatchObject([
      {
        type: "runtime.event",
        event: { type: "agent.text", text: "still-visible-a" },
      },
      {
        type: "runtime.cursor",
      },
      {
        type: "runtime.event",
        event: { type: "agent.text", text: "visible-c" },
      },
    ]);
    expect(JSON.stringify(runtime.events.get("split"))).not.toContain(
      "closed-b",
    );
  });

  it("keeps legacy detail loads from evicting the primary subscription", () => {
    const runtime = fixture();
    runtime.hub.connect("legacy", { kind: "none" }, {
      snapshot,
      approvals: [],
      inputs: [],
      plans: [],
    });
    runtime.events.get("legacy")!.length = 0;

    runtime.hub.ensureConversationSubscription("legacy", CONVERSATION_A);
    runtime.hub.ensureConversationSubscription("legacy", CONVERSATION_B);
    runtime.hub.ensureConversationSubscription("legacy", CONVERSATION_C);

    for (const [conversationId, text] of [
      [CONVERSATION_A, "primary-a"],
      [CONVERSATION_B, "replaced-b"],
      [CONVERSATION_C, "secondary-c"],
    ] as const) {
      runtime.hub.broadcast({
        type: "agent.text",
        conversationId,
        runId: "run",
        turnId: "turn",
        text,
      });
    }

    expect(runtime.events.get("legacy")).toMatchObject([
      {
        type: "runtime.event",
        event: { type: "agent.text", text: "primary-a" },
      },
      { type: "runtime.cursor" },
      {
        type: "runtime.event",
        event: { type: "agent.text", text: "secondary-c" },
      },
    ]);
    expect(JSON.stringify(runtime.events.get("legacy"))).not.toContain(
      "replaced-b",
    );
  });

  it("replays compatible cursors, refreshes incompatible generations, and tears down all clients", () => {
    const runtime = fixture();
    const beforeFreshSnapshot = vi.fn();
    runtime.hub.broadcastSnapshot(snapshot);
    runtime.hub.connect("resumed", {
      kind: "resume",
      runtimeGeneration: GENERATION,
      afterSequence: 0,
      conversationIds: [],
    }, {
      beforeFreshSnapshot,
      snapshot,
      approvals: [],
      inputs: [],
      plans: [],
    });
    expect(runtime.events.get("resumed")?.map(({ type }) => type)).toEqual([
      "server.welcome",
      "runtime.sync.completed",
    ]);
    expect(beforeFreshSnapshot).toHaveBeenCalledTimes(1);

    runtime.hub.connect("reset", {
      kind: "resume",
      runtimeGeneration: "22222222-2222-4222-8222-222222222222",
      afterSequence: 1,
      conversationIds: [],
    }, {
      beforeFreshSnapshot,
      snapshot,
      approvals: [],
      inputs: [],
      plans: [],
    });
    expect(runtime.events.get("reset")?.map(({ type }) => type)).toEqual([
      "server.welcome",
      "runtime.sync.completed",
    ]);
    expect(beforeFreshSnapshot).toHaveBeenCalledTimes(2);

    const terminated: string[] = [];
    runtime.hub.terminateAll((socket) => terminated.push(socket));
    expect(terminated).toEqual(["resumed", "reset"]);
    expect(runtime.hub.connectionCount).toBe(0);
  });

  it("includes active provider maintenance in an authoritative full sync", () => {
    const runtime = fixture();
    runtime.hub.connect("maintenance", { kind: "none" }, {
      snapshot: (sync) => ({
        ...snapshot(sync),
        maintenanceOperations: [maintenanceOperation()],
      }),
      approvals: [],
      inputs: [],
      plans: [],
    });

    const welcome = runtime.events.get("maintenance")?.[0] as Extract<
      ServerEvent,
      { type: "server.welcome" }
    >;
    expect(welcome.snapshot.maintenanceOperations).toEqual([
      expect.objectContaining({
        providerId: "claude",
        status: "running",
        output: null,
      }),
    ]);
  });
});
