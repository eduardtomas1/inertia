import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import type {
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlan,
  AppSnapshot,
  ProviderMaintenanceOperation,
  ServerEvent,
} from "../../src/shared/contracts";
import { parseRuntimeResumeRequest, RuntimeSequencer } from "../../src/server/runtime-sequencing";
import { clientCommandSchema } from "../../src/shared/contracts";
import { RuntimeDetailSubscriptions, runtimeResumeUrl } from "../../src/renderer/src/utils/runtimeSequencing";
import { RuntimeSyncHub } from "../../src/server/runtime/runtime-sync-hub";
import { sendRuntimeEvent } from "../../src/server/runtime-protocol";
import { SerializedRuntimeEvent } from "../../src/server/serialized-runtime-event";

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

function conversationContextInputRequest(): AgentInputRequest {
  return {
    ...inputRequest(),
    questions: [],
    conversationContextRequest: {
      requestId: "input",
      targetConversationId: CONVERSATION_A,
      targetTurnId: "turn",
      requestedSourceConversationId: CONVERSATION_B,
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:05:00.000Z",
    },
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
  const send = (
    socket: string,
    event: ServerEvent | SerializedRuntimeEvent,
    onSent?: (sent: boolean) => void,
  ): void => {
    const current = events.get(socket) ?? [];
    current.push(event instanceof SerializedRuntimeEvent ? event.event : event);
    events.set(socket, current);
    onSent?.(true);
  };
  const hub = new RuntimeSyncHub(
    send,
    new RuntimeSequencer({ runtimeGeneration: GENERATION }),
  );
  return { events, send: vi.fn(send), hub };
}

describe("runtime sync hub", () => {
  it("keeps four live pane subscriptions independent when a pane closes", () => {
    const runtime = fixture();
    const ids = [CONVERSATION_A, CONVERSATION_B, CONVERSATION_C,
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd"];
    runtime.hub.connect("split", { kind: "none" }, {
      snapshot, approvals: [], inputs: [], plans: [],
    });
    for (const [index, owner] of ["primary", "secondary", "tertiary", "quaternary"].entries()) {
      const command = clientCommandSchema.parse({
        requestId: crypto.randomUUID(),
        type: "conversation.detail.subscription",
        payload: { owner, conversationId: ids[index] },
      });
      if (command.type !== "conversation.detail.subscription") throw new Error("Unexpected command.");
      runtime.hub.setConversationSubscription("split", command.payload.owner, command.payload.conversationId);
    }
    const publish = () => {
      runtime.events.get("split")!.length = 0;
      for (const conversationId of ids) runtime.hub.broadcast({
        type: "agent.text", conversationId, runId: "run", turnId: "turn", text: conversationId,
      });
      return runtime.events.get("split")!.map((event) => event.type);
    };
    expect(publish()).toEqual(Array(4).fill("runtime.event"));
    runtime.hub.setConversationSubscription("split", "secondary", null);
    expect(publish()).toEqual(["runtime.event", "runtime.cursor", "runtime.event", "runtime.event"]);
  });

  it("replays and keeps streaming every pane after a four-pane reconnect", () => {
    const runtime = fixture();
    const ids = [CONVERSATION_A, CONVERSATION_B, CONVERSATION_C,
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd"];
    const owners = ["primary", "secondary", "tertiary", "quaternary"] as const;
    const resumeUrl = new URL(runtimeResumeUrl(
      "ws://127.0.0.1:4312/runtime/token", runtime.hub.cursor(),
      owners.map((owner, index) => ({ owner, conversationId: ids[index] })),
    ));
    const publish = () => {
      for (const conversationId of ids) runtime.hub.broadcast({
        type: "agent.text", conversationId, runId: "run", turnId: "turn", text: conversationId,
      });
    };
    publish();
    const resume = parseRuntimeResumeRequest(`${resumeUrl.pathname}${resumeUrl.search}`, "/runtime/token");
    expect(resume).toMatchObject({ kind: "resume", conversationIds: ids });
    runtime.hub.connect("split", resume, { snapshot, approvals: [], inputs: [], plans: [] });
    expect(runtime.events.get("split")!.filter((event) => event.type === "runtime.event"))
      .toHaveLength(4);
    runtime.events.get("split")!.length = 0;
    runtime.hub.setConversationSubscription("split", "secondary", null);
    publish();
    expect(runtime.events.get("split")!.map((event) => event.type))
      .toEqual(["runtime.event", "runtime.cursor", "runtime.event", "runtime.event"]);
  });

  it("preserves a vacant middle owner through reconnect and immediate pane closure", () => {
    const runtime = fixture();
    const subscriptions = new RuntimeDetailSubscriptions();
    subscriptions.set("primary", CONVERSATION_A);
    subscriptions.set("tertiary", CONVERSATION_C);
    const url = new URL(runtimeResumeUrl(
      "ws://127.0.0.1/runtime/token", runtime.hub.cursor(), subscriptions.mountedPanes(),
    ));
    const resume = parseRuntimeResumeRequest(`${url.pathname}${url.search}`, url.pathname);
    expect(resume).toMatchObject({
      kind: "resume", conversationOwners: ["primary", "tertiary"],
    });
    runtime.hub.connect("split", resume, { snapshot, approvals: [], inputs: [], plans: [] });
    runtime.events.get("split")!.length = 0;
    // Closing the still-vacant secondary pane must not evict tertiary before
    // React has had a chance to re-register the mounted panes online.
    runtime.hub.setConversationSubscription("split", "secondary", null);
    runtime.hub.broadcast({
      type: "agent.text", conversationId: CONVERSATION_C,
      runId: "run", turnId: "turn", text: "visible tertiary",
    });
    expect(runtime.events.get("split")!.at(-1)).toMatchObject({ type: "runtime.event" });
    runtime.hub.setConversationSubscription("split", "tertiary", null);
    runtime.hub.broadcast({
      type: "agent.text", conversationId: CONVERSATION_C,
      runId: "run", turnId: "turn", text: "closed tertiary",
    });
    expect(runtime.events.get("split")!.at(-1)).toMatchObject({ type: "runtime.cursor" });
  });

  it("retains duplicate conversation ownership until its last resumed pane closes", () => {
    const runtime = fixture();
    const url = new URL(runtimeResumeUrl("ws://127.0.0.1/runtime/token", runtime.hub.cursor(), [
      { owner: "tertiary", conversationId: CONVERSATION_C },
      { owner: "quaternary", conversationId: CONVERSATION_C },
    ]));
    const resume = parseRuntimeResumeRequest(`${url.pathname}${url.search}`, url.pathname);
    expect(resume.kind).toBe("resume");
    runtime.hub.connect("split", resume, { snapshot, approvals: [], inputs: [], plans: [] });
    const publish = () => runtime.hub.broadcast({
      type: "agent.text", conversationId: CONVERSATION_C,
      runId: "run", turnId: "turn", text: "shared conversation",
    });
    runtime.hub.setConversationSubscription("split", "primary", null);
    runtime.hub.setConversationSubscription("split", "tertiary", null);
    publish();
    expect(runtime.events.get("split")!.at(-1)).toMatchObject({ type: "runtime.event" });
    runtime.hub.setConversationSubscription("split", "quaternary", null);
    publish();
    expect(runtime.events.get("split")!.at(-1)).toMatchObject({ type: "runtime.cursor" });
  });

  it("keeps detached reconnects restricted to their authorized conversation regardless of pane labels", () => {
    const runtime = fixture();
    runtime.hub.connect("detached", {
      kind: "resume", runtimeGeneration: GENERATION, afterSequence: 0,
      conversationIds: [CONVERSATION_B, CONVERSATION_C],
      conversationOwners: ["tertiary", "quaternary"],
    }, { snapshot, approvals: [], inputs: [], plans: [] }, {
      kind: "detached-chat", conversationId: CONVERSATION_A, clientId: "detached",
    });
    runtime.events.get("detached")!.length = 0;
    runtime.hub.setConversationSubscription("detached", "quaternary", CONVERSATION_C);
    for (const conversationId of [CONVERSATION_A, CONVERSATION_B, CONVERSATION_C]) {
      runtime.hub.broadcast({ type: "agent.text", conversationId, runId: "run", turnId: "turn", text: conversationId });
    }
    expect(runtime.events.get("detached")!.map((event) => event.type))
      .toEqual(["runtime.event", "runtime.cursor", "runtime.cursor"]);
  });

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

  it("redacts foreign context identities from detached fresh and live inputs only", () => {
    const runtime = fixture();
    const request = conversationContextInputRequest();
    const fullSnapshot = snapshot(undefined);
    fullSnapshot.projects = [
      { id: "project-a", name: "A" },
    ] as AppSnapshot["projects"];
    fullSnapshot.conversations = [
      { id: CONVERSATION_A, projectId: "project-a", title: "A" },
    ] as AppSnapshot["conversations"];
    const hydration = {
      snapshot: () => fullSnapshot,
      approvals: [],
      inputs: [request],
      plans: [],
    };

    runtime.hub.connect("detached-context", { kind: "none" }, hydration, {
      kind: "detached-chat",
      conversationId: CONVERSATION_A,
      clientId: "window-context",
    });
    runtime.hub.connect("main-context", { kind: "none" }, hydration);
    runtime.hub.setConversationSubscription(
      "main-context",
      "primary",
      CONVERSATION_A,
    );

    const hydratedDetached = runtime.events.get("detached-context")?.find(
      (event): event is Extract<ServerEvent, { type: "agent.input.requested" }> =>
        event.type === "agent.input.requested",
    );
    const hydratedMain = runtime.events.get("main-context")?.find(
      (event): event is Extract<ServerEvent, { type: "agent.input.requested" }> =>
        event.type === "agent.input.requested",
    );
    expect(hydratedDetached?.request.conversationContextRequest)
      .toMatchObject({ requestedSourceConversationId: null });
    expect(hydratedMain?.request).toBe(request);
    expect(request.conversationContextRequest?.requestedSourceConversationId)
      .toBe(CONVERSATION_B);

    runtime.events.get("detached-context")!.length = 0;
    runtime.events.get("main-context")!.length = 0;
    runtime.hub.broadcast({ type: "agent.input.requested", request });

    const liveDetached = runtime.events.get("detached-context")?.[0];
    const liveMain = runtime.events.get("main-context")?.[0];
    expect(liveDetached).toMatchObject({
      type: "runtime.event",
      event: {
        type: "agent.input.requested",
        request: {
          conversationContextRequest: {
            requestedSourceConversationId: null,
          },
        },
      },
    });
    expect(liveMain).toMatchObject({
      type: "runtime.event",
      event: {
        type: "agent.input.requested",
        request: {
          conversationContextRequest: {
            requestedSourceConversationId: CONVERSATION_B,
          },
        },
      },
    });
    expect(
      liveMain?.type === "runtime.event"
      && liveMain.event.type === "agent.input.requested"
        ? liveMain.event.request
        : null,
    ).toBe(request);
  });

  it("owns a fresh socket before sending welcome so an immediate disconnect is not leaked", () => {
    let hub: RuntimeSyncHub<string>;
    const events: ServerEvent[] = [];
    hub = new RuntimeSyncHub((socket, event) => {
      const value = event instanceof SerializedRuntimeEvent ? event.event : event;
      events.push(value);
      if (value.type === "server.welcome") hub.disconnect(socket);
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

  it("delivers background questions, approvals and resolutions live and on replay while isolating detached chats", () => {
    const runtime = fixture();
    const hydration = { snapshot, approvals: [], inputs: [], plans: [] };
    runtime.hub.connect("main", { kind: "none" }, hydration);
    runtime.hub.setConversationSubscription("main", "primary", CONVERSATION_B);
    runtime.hub.connect("detached", { kind: "none" }, hydration, {
      kind: "detached-chat", conversationId: CONVERSATION_B, clientId: "detached",
    });
    runtime.events.get("main")!.length = 0;
    runtime.events.get("detached")!.length = 0;
    const events = [
      { type: "agent.input.requested" as const, request: inputRequest() },
      { type: "agent.approval.requested" as const, request: approval() },
      { type: "agent.input.resolved" as const, conversationId: CONVERSATION_A, runId: "run", turnId: "turn", requestId: "input" },
      { type: "agent.approval.resolved" as const, conversationId: CONVERSATION_A, runId: "run", turnId: "turn", requestId: "approval", decision: "approve" as const },
    ];
    for (const event of events) runtime.hub.broadcast(event);
    for (let index = 0; index < events.length; index++) {
      expect(runtime.events.get("main")?.[index]).toMatchObject({ type: "runtime.event", event: events[index] });
      expect(runtime.events.get("detached")?.[index]).toMatchObject({ type: "runtime.cursor" });
    }
    for (const [socket, authority] of [["replay-main", undefined], ["replay-detached", {
      kind: "detached-chat" as const, conversationId: CONVERSATION_B, clientId: "replay-detached",
    }]] as const) {
      runtime.hub.connect(socket, { kind: "resume", runtimeGeneration: GENERATION, afterSequence: 0,
        conversationIds: [CONVERSATION_B] }, hydration, authority);
      expect(runtime.events.get(socket)?.filter(({ type }) => type === "runtime.event")).toHaveLength(authority ? 0 : 4);
    }
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


describe("search focus routing", () => {
  it.each(["failed", "superseded"] as const)("preserves the current focus intent after a %s asynchronous write", (outcome) => {
    const hub = new RuntimeSyncHub(sendRuntimeEvent);
    const context = { snapshot, approvals: [], inputs: [], plans: [] };
    const authority = { kind: "detached-chat" as const, conversationId: CONVERSATION_A, clientId: "owner" };
    const first = { projectId: GENERATION, conversationId: CONVERSATION_A, turnId: "turn", messageId: "first" };
    const latest = { ...first, messageId: "latest" };
    let closing = false;
    let completeFocus!: (error?: Error) => void;
    const socket = {
      get readyState() { return closing ? WebSocket.CLOSING : WebSocket.OPEN; },
      bufferedAmount: 0,
      terminate: vi.fn(),
      send: (serialized: string, complete: (error?: Error) => void) => {
        const event = JSON.parse(serialized) as ServerEvent;
        if (event.type === "conversation.message.focus") completeFocus = complete;
        else complete();
      },
    } as unknown as WebSocket;
    hub.connect(socket, { kind: "none" }, context, authority);
    hub.focusDetachedMessage(first);
    closing = true;
    if (outcome === "superseded") hub.focusDetachedMessage(latest);
    completeFocus(outcome === "failed" ? new Error("write failed") : undefined);
    expect(socket.terminate).toHaveBeenCalledTimes(outcome === "failed" ? 1 : 0);
    hub.disconnect(socket);
    const received: ServerEvent[] = [];
    const reconnected = {
      readyState: WebSocket.OPEN, bufferedAmount: 0,
      send: (serialized: string, complete: (error?: Error) => void) => {
        received.push(JSON.parse(serialized) as ServerEvent);
        complete();
      },
    } as unknown as WebSocket;
    hub.connect(reconnected, { kind: "none" }, context, authority);
    expect(received.slice(-2)).toEqual([
      expect.objectContaining({ type: "runtime.sync.completed" }),
      { type: "conversation.message.focus", target: outcome === "failed" ? first : latest },
    ]);
  });

  it.each(["live", "hydration"] as const)("retains focus rejected by a closing socket during %s delivery", (phase) => {
    const hub = new RuntimeSyncHub(sendRuntimeEvent);
    const context = { snapshot, approvals: [], inputs: [], plans: [] };
    const authority = { kind: "detached-chat" as const, conversationId: CONVERSATION_A, clientId: "owner" };
    const target = { projectId: GENERATION, conversationId: CONVERSATION_A, turnId: "turn", messageId: "message" };
    let closing = false;
    const blockedEvents: ServerEvent[] = [];
    const blocked = {
      get readyState() { return closing ? WebSocket.CLOSING : WebSocket.OPEN; },
      bufferedAmount: 0,
      send: (serialized: string, complete: (error?: Error) => void) => {
        const event = JSON.parse(serialized) as ServerEvent;
        blockedEvents.push(event);
        if (phase === "hydration" && event.type === "runtime.sync.completed") closing = true;
        complete();
      },
    } as unknown as WebSocket;
    if (phase === "hydration") hub.focusDetachedMessage(target);
    hub.connect(blocked, { kind: "none" }, context, authority);
    if (phase === "live") {
      closing = true;
      hub.focusDetachedMessage(target);
    }
    expect(hub.connectionCount).toBe(1);
    expect(blockedEvents.some(({ type }) => type === "conversation.message.focus")).toBe(false);
    hub.disconnect(blocked);
    const received: ServerEvent[] = [];
    const reconnected = {
      readyState: WebSocket.OPEN, bufferedAmount: 0,
      send: (serialized: string, complete: (error?: Error) => void) => {
        received.push(JSON.parse(serialized) as ServerEvent);
        complete();
      },
    } as unknown as WebSocket;
    hub.connect(reconnected, { kind: "none" }, context, authority);
    expect(received.slice(-2)).toEqual([
      expect.objectContaining({ type: "runtime.sync.completed" }),
      { type: "conversation.message.focus", target },
    ]);
    hub.disconnect(reconnected);
    received.length = 0;
    hub.connect(reconnected, { kind: "none" }, context, authority);
    expect(received.some(({ type }) => type === "conversation.message.focus")).toBe(false);
  });

  it("delivers the latest pending target only after its detached client is hydrated", () => {
    const runtime = fixture();
    const context = { snapshot, approvals: [], inputs: [], plans: [] };
    const target = { projectId: GENERATION, conversationId: CONVERSATION_A, turnId: "turn", messageId: "first" };
    runtime.hub.focusDetachedMessage(target);
    runtime.hub.focusDetachedMessage({ ...target, messageId: "latest" });
    runtime.hub.connect("main", { kind: "none" }, context);
    runtime.hub.connect("other", { kind: "none" }, context, { kind: "detached-chat", conversationId: CONVERSATION_B, clientId: "other" });
    for (const key of ["main", "other"]) expect(runtime.events.get(key)?.some(({ type }) => type === "conversation.message.focus")).toBe(false);
    runtime.hub.connect("owner", { kind: "none" }, context, { kind: "detached-chat", conversationId: CONVERSATION_A, clientId: "owner" });
    expect(runtime.events.get("owner")?.slice(-2)).toEqual([
      expect.objectContaining({ type: "runtime.sync.completed" }),
      { type: "conversation.message.focus", target: { ...target, messageId: "latest" } },
    ]);
    runtime.hub.disconnect("owner");
    runtime.hub.connect("reconnected", { kind: "none" }, context, { kind: "detached-chat", conversationId: CONVERSATION_A, clientId: "owner" });
    expect(runtime.events.get("reconnected")?.some(({ type }) => type === "conversation.message.focus")).toBe(false);
  });

  it("bounds pending targets and expires undelivered navigation", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const runtime = fixture();
      const context = { snapshot, approvals: [], inputs: [], plans: [] };
      for (let index = 0; index < 21; index += 1) runtime.hub.focusDetachedMessage({
        projectId: GENERATION, conversationId: String(index), turnId: "turn", messageId: "message",
      });
      runtime.hub.connect("evicted", { kind: "none" }, context, { kind: "detached-chat", conversationId: "0", clientId: "evicted" });
      expect(runtime.events.get("evicted")?.some(({ type }) => type === "conversation.message.focus")).toBe(false);
      clock.mockReturnValue(10_001);
      runtime.hub.connect("expired", { kind: "none" }, context, { kind: "detached-chat", conversationId: "20", clientId: "expired" });
      expect(runtime.events.get("expired")?.some(({ type }) => type === "conversation.message.focus")).toBe(false);
    } finally { clock.mockRestore(); }
  });

  it("sends focus only to the detached window that owns the conversation", () => {
    const runtime = fixture();
    const context = { snapshot, approvals: [], inputs: [], plans: [] };
    runtime.hub.connect("main", { kind: "none" }, context, { kind: "main" });
    runtime.hub.connect("owner", { kind: "none" }, context, { kind: "detached-chat", conversationId: CONVERSATION_A, clientId: "owner" });
    runtime.hub.connect("other", { kind: "none" }, context, { kind: "detached-chat", conversationId: CONVERSATION_B, clientId: "other" });
    for (const events of runtime.events.values()) events.length = 0;
    const target = { projectId: GENERATION, conversationId: CONVERSATION_A, turnId: "legacy-turn", messageId: "message" };
    runtime.hub.focusDetachedMessage(target);
    expect(runtime.events.get("owner")).toEqual([{ type: "conversation.message.focus", target }]);
    expect(runtime.events.get("main")).toEqual([]);
    expect(runtime.events.get("other")).toEqual([]);
  });
});
