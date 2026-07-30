import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RemoteCompanionClient,
  waitForRemoteRelayMessage,
  waitForRemoteWebSocketOpen,
} from "../remote/browser/src/remote-client";
import type { BrowserDeviceProfile } from "../remote/browser/src/device-store";
import { generateRemoteKeyPair } from "../src/shared/remote-crypto";
import type {
  RemoteRequest,
  RemoteResponse,
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
    this.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify(value),
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
