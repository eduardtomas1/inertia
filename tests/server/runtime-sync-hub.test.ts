import { describe, expect, it, vi } from "vitest";

import type {
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlan,
  AppSnapshot,
  ServerEvent,
} from "../../src/shared/contracts";
import { RuntimeSequencer } from "../../src/server/runtime-sequencing";
import { RuntimeSyncHub } from "../../src/server/runtime/runtime-sync-hub";

const GENERATION = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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
  it("hydrates a fresh connection in order and embeds the authoritative cursor", () => {
    const runtime = fixture();
    runtime.hub.connect("fresh", { kind: "none" }, {
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
    expect(runtime.hub.connectionCount).toBe(1);
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
        conversationId,
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

    runtime.hub.setConversationSubscription("b", CONVERSATION_A);
    runtime.hub.broadcast({
      type: "agent.text",
      conversationId: CONVERSATION_A,
      runId: "run",
      turnId: "turn",
      text: "now-visible",
    });
    expect(runtime.events.get("b")?.[1]).toMatchObject({
      type: "runtime.event",
      sync: { latestSequence: 2 },
      event: { type: "agent.text", text: "now-visible" },
    });
  });

  it("replays compatible cursors, refreshes incompatible generations, and tears down all clients", () => {
    const runtime = fixture();
    runtime.hub.broadcastSnapshot(snapshot);
    runtime.hub.connect("resumed", {
      kind: "resume",
      runtimeGeneration: GENERATION,
      afterSequence: 0,
      conversationId: null,
    }, {
      snapshot,
      approvals: [],
      inputs: [],
      plans: [],
    });
    expect(runtime.events.get("resumed")?.map(({ type }) => type)).toEqual([
      "runtime.resumed",
      "runtime.event",
      "runtime.sync.completed",
    ]);

    runtime.hub.connect("reset", {
      kind: "resume",
      runtimeGeneration: "22222222-2222-4222-8222-222222222222",
      afterSequence: 1,
      conversationId: null,
    }, {
      snapshot,
      approvals: [],
      inputs: [],
      plans: [],
    });
    expect(runtime.events.get("reset")?.map(({ type }) => type)).toEqual([
      "server.welcome",
      "runtime.sync.completed",
    ]);

    const terminated: string[] = [];
    runtime.hub.terminateAll((socket) => terminated.push(socket));
    expect(terminated).toEqual(["resumed", "reset"]);
    expect(runtime.hub.connectionCount).toBe(0);
  });
});
