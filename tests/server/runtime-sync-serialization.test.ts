import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import type {
  AppSnapshot,
  ClientCommand,
  RuntimeMutationEvent,
  RuntimeSequencedFrame,
  RuntimeSyncCursor,
} from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts/app";
import {
  MAX_BUFFERED_RUNTIME_EVENT_BYTES,
  MAX_QUEUED_RUNTIME_EVENT_BYTES,
  MAX_RUNTIME_EVENT_STALL_MS,
  sendRuntimeEvent,
} from "../../src/server/runtime-protocol";
import { RuntimeSequencer } from "../../src/server/runtime-sequencing";
import { CommandIncidents } from "../../src/server/runtime/command-incidents";
import { SerializedRuntimeEvent } from "../../src/server/serialized-runtime-event";
import { projectRuntimeFrameForAuthority } from "../../src/server/runtime/detached-chat-runtime-projection";
import {
  MAIN_RUNTIME_CLIENT_AUTHORITY,
  type RuntimeClientAuthority,
} from "../../src/server/runtime/runtime-client-authority";
import { RuntimeSyncHub } from "../../src/server/runtime/runtime-sync-hub";

const GENERATION = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const run = (conversationId: string) => ({
  id: `run-${conversationId}`,
  conversationId,
  status: "running",
});

function snapshot(sync: RuntimeSyncCursor): AppSnapshot {
  return {
    projects: [
      { id: "project-a", name: "Alpha project" },
      { id: "project-b", name: "Beta private project" },
    ],
    conversations: [
      { id: CONVERSATION_A, projectId: "project-a", title: "Alpha" },
      { id: CONVERSATION_B, projectId: "project-b", title: "Beta private" },
    ],
    runs: [run(CONVERSATION_A), run(CONVERSATION_B)],
    providers: [{ id: "codex", maintenance: { status: "private maintenance" } }],
    backendProfiles: [],
    backendDefaults: [],
    settings: defaultSettings,
    promptPresets: [],
    activeProjectId: "project-a",
    activeConversationId: CONVERSATION_A,
    sync,
  } as unknown as AppSnapshot;
}

const text = (conversationId: string, value: string): RuntimeMutationEvent => ({
  type: "agent.text",
  conversationId,
  runId: "run",
  turnId: "turn",
  text: value,
});

const betaShell = {
  type: "conversation.shell.updated",
  conversation: { id: CONVERSATION_B, projectId: "project-b", title: "Beta private" },
  runs: [run(CONVERSATION_A), run(CONVERSATION_B)],
} as unknown as RuntimeMutationEvent;

const maintenance = {
  type: "provider.maintenance.operation",
  operation: { id: "operation", providerId: "codex", status: "running" },
} as unknown as RuntimeMutationEvent;

function detached(conversationId: string): RuntimeClientAuthority {
  return { kind: "detached-chat", conversationId, clientId: conversationId };
}

function client(authority: RuntimeClientAuthority, conversationIds: string[]) {
  const sent: string[] = [];
  const raw = {
    readyState: WebSocket.OPEN as number,
    bufferedAmount: 0,
    send: vi.fn((serialized: string, complete: (error?: Error) => void) => {
      sent.push(serialized);
      complete();
    }),
    terminate: vi.fn(),
  };
  return { authority, conversationIds, raw, socket: raw as unknown as WebSocket, sent };
}

type Client = ReturnType<typeof client>;

function runtime(clients: Client[]) {
  const sequencer = new RuntimeSequencer({ runtimeGeneration: GENERATION });
  const commit = vi.spyOn(sequencer, "commit");
  const hub = new RuntimeSyncHub(sendRuntimeEvent, sequencer);
  for (const current of clients) {
    hub.connect(
      current.socket,
      { kind: "none" },
      { snapshot, approvals: [], inputs: [], plans: [] },
      current.authority,
    );
    if (current.authority.kind === "main" && current.conversationIds[0]) {
      hub.setConversationSubscription(current.socket, "primary", current.conversationIds[0]);
    }
    current.sent.length = 0;
  }
  return { hub, committed: () => commit.mock.results.at(-1)!.value.event };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("runtime frame serialization fan-out", () => {
  it("serializes each distinct projected frame once and delivers byte-identical sequenced frames", () => {
    const clients = [
      client(MAIN_RUNTIME_CLIENT_AUTHORITY, [CONVERSATION_A]),
      client(MAIN_RUNTIME_CLIENT_AUTHORITY, [CONVERSATION_A]),
      client(MAIN_RUNTIME_CLIENT_AUTHORITY, [CONVERSATION_A]),
      client(MAIN_RUNTIME_CLIENT_AUTHORITY, [CONVERSATION_B]),
      client(MAIN_RUNTIME_CLIENT_AUTHORITY, []),
      client(detached(CONVERSATION_A), [CONVERSATION_A]),
      client(detached(CONVERSATION_B), [CONVERSATION_B]),
    ];
    const { hub, committed } = runtime(clients);
    const stringify = vi.spyOn(JSON, "stringify");
    const publications = [
      () => hub.broadcast(text(CONVERSATION_A, "alpha delta")),
      () => hub.broadcastSnapshot(snapshot),
      () => hub.broadcast(betaShell),
      () => hub.broadcast(text(CONVERSATION_B, "beta private delta")),
      () => hub.broadcast(maintenance),
    ];
    const serializations: number[] = [];

    for (const [index, publish] of publications.entries()) {
      stringify.mockClear();
      publish();
      serializations.push(stringify.mock.calls.length);
      const frame = committed();
      const references = clients.map(({ authority, conversationIds }) =>
        JSON.stringify(projectRuntimeFrameForAuthority(frame, { conversationIds }, authority)));
      expect(clients.map(({ sent }) => sent[index])).toEqual(references);
      expect(serializations[index]).toBe(new Set(references).size);
    }

    expect(serializations).toEqual([2, 3, 3, 2, 2]);
    for (const { sent } of clients) {
      expect(sent.map((serialized) => (JSON.parse(serialized) as RuntimeSequencedFrame).sync))
        .toEqual([1, 2, 3, 4, 5].map((latestSequence) => ({
          runtimeGeneration: GENERATION,
          latestSequence,
        })));
    }
    expect(clients[0]!.sent).toEqual(clients[1]!.sent);
    expect(clients[0]!.sent).toEqual(clients[2]!.sent);
    expect(clients[5]!.sent.join("\n")).not.toContain("Beta private");
    expect(clients[5]!.sent.join("\n")).not.toContain("beta private delta");
    expect(clients[6]!.sent.join("\n")).not.toContain("alpha delta");
    expect(clients[6]!.sent.join("\n")).not.toContain("private maintenance");
  });

  it("applies every client's own closed, saturation and stall limits to the shared payload", () => {
    vi.useFakeTimers();
    const [fast, stalled, saturated, closed] = [0, 1, 2, 3].map(() =>
      client(MAIN_RUNTIME_CLIENT_AUTHORITY, [CONVERSATION_A]));
    const { hub } = runtime([fast!, stalled!, saturated!, closed!]);
    stalled!.raw.bufferedAmount = MAX_BUFFERED_RUNTIME_EVENT_BYTES + 1;
    saturated!.raw.bufferedAmount = MAX_QUEUED_RUNTIME_EVENT_BYTES - 1;
    closed!.raw.readyState = WebSocket.CLOSED;
    const stringify = vi.spyOn(JSON, "stringify");

    hub.broadcast(text(CONVERSATION_A, "alpha delta"));

    expect(stringify).toHaveBeenCalledOnce();
    expect(fast!.sent).toHaveLength(1);
    expect(stalled!.sent).toEqual(fast!.sent);
    expect(saturated!.sent).toEqual([]);
    expect(saturated!.raw.terminate).toHaveBeenCalledOnce();
    expect(closed!.sent).toEqual([]);
    expect(closed!.raw.terminate).not.toHaveBeenCalled();
    expect(stalled!.raw.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MAX_RUNTIME_EVENT_STALL_MS);
    expect(stalled!.raw.terminate).toHaveBeenCalledOnce();
    expect(fast!.raw.terminate).not.toHaveBeenCalled();
  });

  it("measures retained replay bytes from the shared serialization and keeps unretained snapshots lazy", () => {
    const sequencer = new RuntimeSequencer({ runtimeGeneration: GENERATION });
    const stringify = vi.spyOn(JSON, "stringify");

    sequencer.commit((sync) => ({ type: "snapshot.updated", snapshot: snapshot(sync) }));
    expect(stringify).not.toHaveBeenCalled();
    const committed = sequencer.commit(() => text(CONVERSATION_A, "ünïcødé ✓"));
    const encoded = committed.encode();
    expect(stringify).toHaveBeenCalledOnce();
    stringify.mockRestore();

    expect(encoded.text).toBe(JSON.stringify(committed.event));
    expect(encoded.bytes).toBe(Buffer.byteLength(encoded.text, "utf8"));
    expect(encoded.bytes).toBeGreaterThan(encoded.text.length);
  });

  it("passes shared payloads through the incident sender and still decorates request errors", () => {
    const incidents = new CommandIncidents(vi.fn());
    const marks: string[] = [];
    const send = incidents.sender({ mark: (stage) => marks.push(stage) });
    const committed = new RuntimeSequencer({ runtimeGeneration: GENERATION })
      .commit(() => text(CONVERSATION_A, "alpha delta"));
    const [first, second] = [0, 1].map(() => client(MAIN_RUNTIME_CLIENT_AUTHORITY, [CONVERSATION_A]));
    const stringify = vi.spyOn(JSON, "stringify");

    send(first!.socket, committed);
    send(second!.socket, committed);

    expect(stringify).not.toHaveBeenCalled();
    expect(first!.sent).toEqual([committed.encode().text]);
    expect(second!.sent).toEqual(first!.sent);
    expect(marks).toEqual([
      "runtime-event-serialized",
      "runtime-websocket-send-started",
      "runtime-websocket-send-accepted",
      "runtime-event-serialized",
      "runtime-websocket-send-started",
      "runtime-websocket-send-accepted",
    ]);

    const command = { requestId: "request", type: "settings.update", payload: {} } as unknown as ClientCommand;
    incidents.run(command, () => send(first!.socket, new SerializedRuntimeEvent({
      type: "request.error",
      requestId: "request",
      message: "Failed.",
    })));
    expect(JSON.parse(first!.sent.at(-1)!)).toEqual({
      type: "request.error",
      requestId: "request",
      message: "Failed.",
      diagnosticId: expect.any(String),
    });
  });
});
