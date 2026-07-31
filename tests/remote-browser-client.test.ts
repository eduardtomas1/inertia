import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RemoteCompanionClient,
  waitForRemoteRelayMessage,
  waitForRemoteWebSocketOpen,
} from "../remote/browser/src/remote-client";
import type { BrowserDeviceProfile } from "../remote/browser/src/device-store";
import { generateRemoteKeyPair } from "../src/shared/remote-crypto";
import {
  REMOTE_LIMITS,
  type RemoteRequest,
  type RemoteResponse,
} from "../src/shared/remote-protocol";

class FakeBrowserSocket extends EventTarget {
  static instances: FakeBrowserSocket[] = [];

  readyState = 0;
  readonly sent: string[] = [];
  readonly closeCalls: Array<[number | undefined, string | undefined]> = [];
  private readonly counts = new Map<string, number>();

  constructor(readonly url: string) {
    super();
    FakeBrowserSocket.instances.push(this);
  }

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, callback, options);
    if (callback) this.counts.set(type, (this.counts.get(type) ?? 0) + 1);
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    super.removeEventListener(type, callback, options);
    if (callback) {
      this.counts.set(type, Math.max(0, (this.counts.get(type) ?? 0) - 1));
    }
  }

  listenerCount(type: string): number {
    return this.counts.get(type) ?? 0;
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  message(value: unknown): void {
    this.rawMessage(JSON.stringify(value));
  }

  rawMessage(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", {
      data: value,
    }));
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push([code, reason]);
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeBrowserSocket.instances = [];
});

describe("Remote Companion browser connection ownership", () => {
  it("lets only the newest overlapping connect attempt own the session", async () => {
    vi.stubGlobal("WebSocket", FakeBrowserSocket);
    const deviceKeys = await generateRemoteKeyPair();
    const hostKeys = await generateRemoteKeyPair();
    const profile: BrowserDeviceProfile = {
      version: 1,
      deviceId: crypto.randomUUID(),
      deviceLabel: "Test browser",
      keyPair: deviceKeys,
      hostId: crypto.randomUUID(),
      hostPublicKey: hostKeys.publicKey,
      relayUrl: "wss://relay.example/remote",
      endpointId: "opaque_endpoint",
      scopes: ["view"],
      projectIds: ["project"],
      grantVersion: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const statuses: string[] = [];
    const client = new RemoteCompanionClient({
      status: (message) => statuses.push(message),
      pairingCode: vi.fn(),
      shell: vi.fn(),
      detail: vi.fn(),
      promptResult: vi.fn(),
    });
    (client as unknown as { profile: BrowserDeviceProfile | null }).profile =
      profile;

    const firstAttempt = client.connect();
    const first = FakeBrowserSocket.instances[0]!;
    const secondAttempt = client.connect();
    const second = FakeBrowserSocket.instances[1]!;
    expect(first.closeCalls).toHaveLength(1);

    first.open();
    second.open();
    await vi.waitFor(() => expect(second.sent).toHaveLength(1));
    second.message({
      protocolVersion: 1,
      type: "relay.connected",
      connectionId: crypto.randomUUID(),
    });
    await vi.waitFor(() => expect(second.sent).toHaveLength(2));
    expect(
      (client as unknown as { socket: WebSocket | null }).socket,
    ).toBe(second);

    const thirdAttempt = client.connect();
    const third = FakeBrowserSocket.instances[2]!;
    expect(second.closeCalls).toHaveLength(1);
    (
      client as unknown as { disconnect(message: string): void }
    ).disconnect("cleanup");
    expect(third.closeCalls).toHaveLength(1);
    await Promise.all([firstAttempt, secondAttempt, thirdAttempt]);
    expect(statuses.at(-1)).toBe("cleanup");
  });

  it("cleans open/relay listeners, timers, and sockets on timeout or close", async () => {
    vi.useFakeTimers();
    const opening = new FakeBrowserSocket("wss://relay.example/remote");
    const openResult = waitForRemoteWebSocketOpen(
      opening as unknown as WebSocket,
    );
    const openRejection = expect(openResult).rejects.toThrow("timed out");
    expect(opening.listenerCount("open")).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await openRejection;
    expect(opening.closeCalls).toHaveLength(1);
    expect(opening.listenerCount("open")).toBe(0);
    expect(opening.listenerCount("error")).toBe(0);
    expect(opening.listenerCount("close")).toBe(0);

    const relaying = new FakeBrowserSocket("wss://relay.example/remote");
    const relayResult = waitForRemoteRelayMessage(
      relaying as unknown as WebSocket,
      () => true,
      1_000,
    );
    const relayRejection = expect(relayResult).rejects.toThrow("closed");
    relaying.close(1000, "closed");
    await relayRejection;
    expect(relaying.listenerCount("message")).toBe(0);
    expect(relaying.listenerCount("error")).toBe(0);
    expect(relaying.listenerCount("close")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes oversized relay envelopes before parsing handshake JSON", async () => {
    const parse = vi.spyOn(JSON, "parse");
    const oversized = new FakeBrowserSocket("wss://relay.example/remote");
    const oversizedResult = waitForRemoteRelayMessage(
      oversized as unknown as WebSocket,
      () => true,
      1_000,
    );
    const startedAt = performance.now();
    oversized.rawMessage("x".repeat(
      REMOTE_LIMITS.relayEnvelopeBytes + 1,
    ));
    await expect(oversizedResult).rejects.toThrow("protocol limit");
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(parse).not.toHaveBeenCalled();
    expect(oversized.closeCalls).toEqual([
      [1009, "relay message too large"],
    ]);
    expect(oversized.listenerCount("message")).toBe(0);

    const multibyte = new FakeBrowserSocket("wss://relay.example/remote");
    const multibyteResult = waitForRemoteRelayMessage(
      multibyte as unknown as WebSocket,
      () => true,
      1_000,
    );
    multibyte.rawMessage("\u0800".repeat(
      Math.floor(REMOTE_LIMITS.relayEnvelopeBytes / 3) + 1,
    ));
    await expect(multibyteResult).rejects.toThrow("protocol limit");
    expect(parse).not.toHaveBeenCalled();
    expect(multibyte.closeCalls).toEqual([
      [1009, "relay message too large"],
    ]);
  });

  it("rejects unsupported relay data and ignores bounded malformed JSON", async () => {
    const unsupported = new FakeBrowserSocket("wss://relay.example/remote");
    const unsupportedResult = waitForRemoteRelayMessage(
      unsupported as unknown as WebSocket,
      () => true,
      1_000,
    );
    unsupported.rawMessage(new Uint8Array([1, 2, 3]));
    await expect(unsupportedResult).rejects.toThrow("unsupported");
    expect(unsupported.closeCalls).toEqual([
      [1003, "relay messages must be text"],
    ]);

    const malformed = new FakeBrowserSocket("wss://relay.example/remote");
    const malformedResult = waitForRemoteRelayMessage(
      malformed as unknown as WebSocket,
      (message) => message.type === "relay.error",
      1_000,
    );
    malformed.rawMessage("{");
    malformed.message({
      protocolVersion: 1,
      type: "relay.error",
      code: "desktop-offline",
    });
    await expect(malformedResult).resolves.toMatchObject({
      type: "relay.error",
      code: "desktop-offline",
    });
    expect(malformed.closeCalls).toEqual([]);
  });

  it("applies the pre-parse envelope bound to active session messages", async () => {
    const parse = vi.spyOn(JSON, "parse");
    const socket = new FakeBrowserSocket("wss://relay.example/remote");
    const client = new RemoteCompanionClient({
      status: vi.fn(),
      pairingCode: vi.fn(),
      shell: vi.fn(),
      detail: vi.fn(),
      promptResult: vi.fn(),
    });

    await (
      client as unknown as {
        handleMessage(socket: WebSocket, raw: unknown): Promise<void>;
      }
    ).handleMessage(
      socket as unknown as WebSocket,
      "x".repeat(REMOTE_LIMITS.relayEnvelopeBytes + 1),
    );

    expect(parse).not.toHaveBeenCalled();
    expect(socket.closeCalls).toEqual([
      [1009, "relay message too large"],
    ]);
  });

  it("reports offline and stops polling when a live refresh is not acknowledged", async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const client = new RemoteCompanionClient({
      status: (message) => statuses.push(message),
      pairingCode: vi.fn(),
      shell: vi.fn(),
      detail: vi.fn(),
      promptResult: vi.fn(),
    });
    Object.assign(client as unknown as Record<string, unknown>, {
      sender: {
        context: {
          seal: vi.fn(async () => new Uint8Array([1, 2, 3])),
        },
        sequence: 1,
      },
      sessionId: crypto.randomUUID(),
      connectionId: crypto.randomUUID(),
      socket: { send: vi.fn(), close: vi.fn() },
    });

    client.selectConversation(crypto.randomUUID());
    await vi.advanceTimersByTimeAsync(10_000);

    expect(statuses.at(-1)).toBe("The desktop is offline.");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears stale detail and rejects prompts for the previous selection", async () => {
    const detail = vi.fn();
    const promptResult = vi.fn();
    const request = vi.fn((
      value: RemoteRequest,
    ): Promise<RemoteResponse> => {
      if (value.type !== "prompt.send") return new Promise(() => undefined);
      return Promise.resolve({
        type: "response",
        requestId: value.requestId,
        ok: true,
        result: {
          kind: "prompt.accepted",
          deliveryId: value.deliveryId,
          turnId: "remote-turn",
        },
      });
    });
    const client = new RemoteCompanionClient({
      status: vi.fn(),
      pairingCode: vi.fn(),
      shell: vi.fn(),
      detail,
      promptResult,
    });
    Object.assign(client as unknown as Record<string, unknown>, {
      sender: {},
      request,
    });
    const previousId = crypto.randomUUID();
    const selectedId = crypto.randomUUID();

    client.selectConversation(previousId);
    expect(detail).toHaveBeenLastCalledWith(null);
    expect(
      detail.mock.invocationCallOrder[0],
    ).toBeLessThan(request.mock.invocationCallOrder[0]!);
    client.selectConversation(selectedId);
    expect(detail).toHaveBeenLastCalledWith(null);

    await client.sendPrompt(previousId, "stale target");
    expect(promptResult).toHaveBeenLastCalledWith(
      "The selected conversation changed. The prompt was not sent.",
      false,
    );
    expect(request.mock.calls.filter(
      ([value]) => value.type === "prompt.send",
    )).toHaveLength(0);

    await client.sendPrompt(selectedId, "current target");
    expect(request.mock.calls.find(
      ([value]) => value.type === "prompt.send",
    )?.[0]).toMatchObject({
      type: "prompt.send",
      conversationId: selectedId,
      content: "current target",
    });
  });

  it("clears current detail when the conversation is archived", async () => {
    vi.useFakeTimers();
    const now = new Date().toISOString();
    const conversationId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    let detailRequests = 0;
    const detail = vi.fn();
    const request = vi.fn(async (
      value: RemoteRequest,
    ): Promise<RemoteResponse> => {
      if (value.type === "state.get") {
        return {
          type: "response",
          requestId: value.requestId,
          ok: true,
          result: {
            kind: "state",
            state: {
              generatedAt: now,
              projects: [{ id: projectId, name: "Project" }],
              conversations: [],
              runs: [],
            },
          },
        };
      }
      if (value.type === "conversation.get" && detailRequests++ === 0) {
        return {
          type: "response",
          requestId: value.requestId,
          ok: true,
          result: {
            kind: "conversation",
            detail: {
              generatedAt: now,
              conversation: {
                id: conversationId,
                projectId,
                title: "Conversation",
                providerLabel: "Provider",
                status: "idle",
                pendingLocalApproval: false,
                updatedAt: now,
              },
              messages: [],
              activities: [],
              subagents: [],
              waitingForLocalAction: false,
            },
          },
        };
      }
      return {
        type: "response",
        requestId: value.requestId,
        ok: false,
        code: "not-found",
        message: "The archived conversation is no longer available.",
      };
    });
    const client = new RemoteCompanionClient({
      status: vi.fn(),
      pairingCode: vi.fn(),
      shell: vi.fn(),
      detail,
      promptResult: vi.fn(),
    });
    Object.assign(client as unknown as Record<string, unknown>, {
      sender: {},
      request,
    });

    client.selectConversation(conversationId);
    await vi.waitFor(() => {
      expect(detail).toHaveBeenLastCalledWith(expect.objectContaining({
        conversation: expect.objectContaining({ id: conversationId }),
      }));
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(detail).toHaveBeenLastCalledWith(null));
    expect(detail.mock.calls).toHaveLength(3);
    (
      client as unknown as { disconnect(message: string): void }
    ).disconnect("cleanup");
  });

  it("does not let an old not-found response clear a newer selection", async () => {
    const now = new Date().toISOString();
    const projectId = crypto.randomUUID();
    const oldId = crypto.randomUUID();
    const currentId = crypto.randomUUID();
    let oldRequestStarted = (): void => undefined;
    const oldStarted = new Promise<void>((resolve) => {
      oldRequestStarted = resolve;
    });
    let resolveOld = (_response: RemoteResponse): void => undefined;
    const oldResponse = new Promise<RemoteResponse>((resolve) => {
      resolveOld = resolve;
    });
    const detail = vi.fn();
    const request = vi.fn((
      value: RemoteRequest,
    ): Promise<RemoteResponse> => {
      if (value.type === "state.get") {
        return Promise.resolve({
          type: "response",
          requestId: value.requestId,
          ok: true,
          result: {
            kind: "state",
            state: {
              generatedAt: now,
              projects: [],
              conversations: [],
              runs: [],
            },
          },
        });
      }
      if (
        value.type === "conversation.get"
        && value.conversationId === oldId
      ) {
        oldRequestStarted();
        return oldResponse;
      }
      return Promise.resolve({
        type: "response",
        requestId: value.requestId,
        ok: true,
        result: {
          kind: "conversation",
          detail: {
            generatedAt: now,
            conversation: {
              id: currentId,
              projectId,
              title: "Current conversation",
              providerLabel: "Provider",
              status: "idle",
              pendingLocalApproval: false,
              updatedAt: now,
            },
            messages: [],
            activities: [],
            subagents: [],
            waitingForLocalAction: false,
          },
        },
      });
    });
    const client = new RemoteCompanionClient({
      status: vi.fn(),
      pairingCode: vi.fn(),
      shell: vi.fn(),
      detail,
      promptResult: vi.fn(),
    });
    Object.assign(client as unknown as Record<string, unknown>, {
      sender: {},
      request,
    });

    client.selectConversation(oldId);
    await oldStarted;
    client.selectConversation(currentId);
    await vi.waitFor(() => {
      expect(detail).toHaveBeenLastCalledWith(expect.objectContaining({
        conversation: expect.objectContaining({ id: currentId }),
      }));
    });
    resolveOld({
      type: "response",
      requestId: crypto.randomUUID(),
      ok: false,
      code: "not-found",
      message: "The old conversation disappeared.",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(detail).toHaveBeenLastCalledWith(expect.objectContaining({
      conversation: expect.objectContaining({ id: currentId }),
    }));
    (
      client as unknown as { disconnect(message: string): void }
    ).disconnect("cleanup");
  });

  it("keeps one polling loop across repeated conversation selection refreshes", async () => {
    vi.useFakeTimers();
    const now = new Date().toISOString();
    let blockNextState = false;
    let releaseState = (): void => undefined;
    const stateReleased = new Promise<void>((resolve) => {
      releaseState = resolve;
    });
    const request = vi.fn(async (
      value: RemoteRequest,
    ): Promise<RemoteResponse> => {
      if (value.type === "state.get") {
        if (blockNextState) {
          blockNextState = false;
          await stateReleased;
        }
        return {
          type: "response",
          requestId: value.requestId,
          ok: true,
          result: {
            kind: "state",
            state: {
              generatedAt: now,
              projects: [],
              conversations: [],
              runs: [],
            },
          },
        };
      }
      return {
        type: "response",
        requestId: value.requestId,
        ok: true,
        result: {
          kind: "conversation",
          detail: {
            generatedAt: now,
            conversation: {
              id: value.type === "conversation.get"
                ? value.conversationId
                : crypto.randomUUID(),
              projectId: "project",
              title: "Conversation",
              providerLabel: "Provider",
              status: "idle",
              pendingLocalApproval: false,
              updatedAt: now,
            },
            messages: [],
            activities: [],
            subagents: [],
            waitingForLocalAction: false,
          },
        },
      };
    });
    const client = new RemoteCompanionClient({
      status: vi.fn(),
      pairingCode: vi.fn(),
      shell: vi.fn(),
      detail: vi.fn(),
      promptResult: vi.fn(),
    });
    Object.assign(client as unknown as Record<string, unknown>, {
      sender: {},
      request,
    });

    client.selectConversation(crypto.randomUUID());
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(vi.getTimerCount()).toBe(1);

    blockNextState = true;
    client.selectConversation(crypto.randomUUID());
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(vi.getTimerCount()).toBe(0);

    client.selectConversation(crypto.randomUUID());
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(5));
    expect(vi.getTimerCount()).toBe(1);
    releaseState();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));

    for (let index = 0; index < 20; index += 1) {
      client.selectConversation(crypto.randomUUID());
    }
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(26));
    expect(vi.getTimerCount()).toBe(1);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const callsBeforePoll = request.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => {
        expect(request).toHaveBeenCalledTimes(callsBeforePoll + 2);
      });
      expect(vi.getTimerCount()).toBe(1);
    }
  });
});
