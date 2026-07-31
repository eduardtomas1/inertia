import { describe, expect, it, vi } from "vitest";

import { RemoteRequestDispatcher } from "../../src/main/remote-access-request-dispatcher";
import type {
  ActiveRemoteSession,
  RemoteAccessServiceOptions,
} from "../../src/main/remote-access-service-types";
import type {
  PersistedRemoteAccess,
  PersistedRemoteDevice,
} from "../../src/main/remote-access-store";
import type {
  RemoteRequest,
  RemoteResponse,
} from "../../src/shared/remote-protocol";

function dispatcherFixture(options: {
  authorize: boolean;
  commitRemotePrompt: NonNullable<
    RemoteAccessServiceOptions["runtime"]["commitRemotePrompt"]
  >;
}) {
  const device: PersistedRemoteDevice = {
    id: "11111111-1111-4111-8111-111111111111",
    label: "Browser",
    publicKey: "public-key",
    scopes: ["view", "prompt"],
    projectIds: ["project-1"],
    createdAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-02-01T00:00:00.000Z",
    lastSeenAt: null,
    revokedAt: null,
    grantVersion: 1,
  };
  const request: Extract<RemoteRequest, { type: "prompt.send" }> = {
    type: "prompt.send",
    requestId: "22222222-2222-4222-8222-222222222222",
    deliveryId: "33333333-3333-4333-8333-333333333333",
    conversationId: "conversation-1",
    content: "Do not deliver after authority changes",
  };
  const data: PersistedRemoteAccess = {
    version: 1,
    enabled: true,
    relayUrl: "wss://relay.example/remote",
    hostId: "44444444-4444-4444-8444-444444444444",
    endpointId: "endpoint",
    keyPair: {
      publicKey: "host-public",
      privateKey: "host-private",
    },
    devices: [device],
    audit: [],
    receipts: [],
    usedSessions: [],
  };
  const respond = vi.fn(async (_session, _response: RemoteResponse) => {
    // The response is captured by the spy.
  });
  const persist = vi.fn(async () => undefined);
  const audit = vi.fn();
  const session = {
    connectionId: "connection-1",
    connectionEpoch: 1,
    sessionId: "55555555-5555-4555-8555-555555555555",
    device,
    subject: {
      deviceId: device.id,
      sessionId: "55555555-5555-4555-8555-555555555555",
      scopes: ["view", "prompt"],
      projectIds: ["project-1"],
      grantVersion: 1,
      expiresAt: device.expiresAt,
    },
    inFlight: new Map([[request.requestId, request]]),
    postedPromptDeliveries: new Set(),
  } as unknown as ActiveRemoteSession;
  const dispatcher = new RemoteRequestDispatcher({
    runtime: {
      remoteRequest: async () => {
        throw new Error("unused");
      },
      prepareRemotePrompt: async () => ({
        preparationId: "66666666-6666-4666-8666-666666666666",
      }),
      commitRemotePrompt: options.commitRemotePrompt,
    },
    data: () => data,
    now: () => new Date("2030-01-01T00:00:00.000Z"),
    persist,
    audit,
    isCurrent: () => true,
    authorizePromptCommit: () => options.authorize,
    respond,
  });
  return { audit, data, dispatcher, persist, request, respond, session };
}

describe("remote request dispatcher", () => {
  it("reports an authority change as known non-delivery without uncertainty", async () => {
    const commitRemotePrompt = vi.fn(async (): Promise<RemoteResponse> => {
      throw new Error("must not commit");
    });
    const fixture = dispatcherFixture({
      authorize: false,
      commitRemotePrompt,
    });

    await fixture.dispatcher.dispatch(fixture.session, fixture.request);

    expect(commitRemotePrompt).not.toHaveBeenCalled();
    expect(fixture.respond).toHaveBeenCalledWith(fixture.session, {
      type: "response",
      requestId: fixture.request.requestId,
      ok: false,
      code: "forbidden",
      message: "Remote prompt authority changed before delivery.",
    });
    expect(fixture.data.receipts).toEqual([]);
    expect(fixture.audit).not.toHaveBeenCalled();
    expect(fixture.persist).toHaveBeenCalledTimes(2);
    expect(fixture.session.inFlight.size).toBe(0);
  });

  it("does not mark uncertainty when the runtime rejects before posting", async () => {
    const commitRemotePrompt = vi.fn(async (): Promise<RemoteResponse> => {
      throw new Error("The local runtime is stopping.");
    });
    const fixture = dispatcherFixture({
      authorize: true,
      commitRemotePrompt,
    });

    await fixture.dispatcher.dispatch(fixture.session, fixture.request);

    expect(commitRemotePrompt).toHaveBeenCalledOnce();
    expect(fixture.respond).toHaveBeenCalledWith(fixture.session, {
      type: "response",
      requestId: fixture.request.requestId,
      ok: false,
      code: "unavailable",
      message: "The local runtime is unavailable.",
    });
    expect(fixture.data.receipts).toEqual([]);
    expect(fixture.audit).not.toHaveBeenCalledWith(
      "prompt.uncertain",
      expect.anything(),
      expect.anything(),
    );
    expect(fixture.persist).toHaveBeenCalledTimes(2);
    expect(fixture.session.inFlight.size).toBe(0);
  });

  it("marks uncertainty only after the commit was synchronously posted", async () => {
    const commitRemotePrompt = vi.fn(async (
      _subject,
      _request,
      _preparationId,
      onPosted,
    ): Promise<RemoteResponse> => {
      onPosted?.();
      throw new Error("The runtime stopped before acknowledging the commit.");
    });
    const fixture = dispatcherFixture({
      authorize: true,
      commitRemotePrompt,
    });

    await fixture.dispatcher.dispatch(fixture.session, fixture.request);

    expect(fixture.respond).toHaveBeenCalledWith(fixture.session, {
      type: "response",
      requestId: fixture.request.requestId,
      ok: false,
      code: "uncertain",
      message: "Prompt delivery is uncertain. Do not retry automatically.",
    });
    expect(fixture.data.receipts).toEqual([
      expect.objectContaining({
        deliveryId: fixture.request.deliveryId,
        state: "uncertain",
      }),
    ]);
    expect(fixture.audit).toHaveBeenCalledWith(
      "prompt.uncertain",
      fixture.session.device.id,
      "A remote prompt has uncertain delivery.",
    );
    expect(fixture.persist).toHaveBeenCalledTimes(2);
  });

  it("keeps a posted commit deterministic when the runtime rejects it", async () => {
    const commitRemotePrompt = vi.fn(async (
      _subject,
      request,
      _preparationId,
      onPosted,
    ): Promise<RemoteResponse> => {
      onPosted?.();
      return {
        type: "response",
        requestId: request.requestId,
        ok: false,
        code: "forbidden",
        message: "Remote prompt authorization is no longer current.",
      };
    });
    const fixture = dispatcherFixture({
      authorize: true,
      commitRemotePrompt,
    });

    await fixture.dispatcher.dispatch(fixture.session, fixture.request);

    expect(fixture.respond).toHaveBeenCalledWith(fixture.session, {
      type: "response",
      requestId: fixture.request.requestId,
      ok: false,
      code: "forbidden",
      message: "Remote prompt authorization is no longer current.",
    });
    expect(fixture.data.receipts).toEqual([]);
    expect(fixture.audit).not.toHaveBeenCalled();
    expect(fixture.persist).toHaveBeenCalledTimes(2);
  });
});
