import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderSteerDeliveryUnknownError } from "../../src/server/provider/contracts";
import {
  createTurnInteractionCommandHandler,
  type TurnInteractionCommandDependencies,
} from "../../src/server/runtime/commands/turn-interaction-commands";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestAttachment,
  turnControllerTestIdentity,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

async function activeFollowUpRuntime() {
  const runtime = await createTurnControllerTestRuntime();
  const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Start" });
  runtime.controller.start(queued.turn.id);
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "status", status: "running" });
  const retained = await turnControllerTestAttachment(runtime, randomUUID());
  const conversationAttachments = {
    retain: vi.fn(async () => [retained]),
    acceptRetention: vi.fn(),
    release: vi.fn(async () => undefined),
    releaseRetention: vi.fn(async () => undefined),
  };
  const attachmentResolver = {
    resolvePayloads: vi.fn(async () => [{ attachment: retained, bytes: new Uint8Array([0x89]) }]),
    releaseAll: vi.fn(async () => undefined),
    relinquishAll: vi.fn(async () => undefined),
  };
  const handler = createTurnInteractionCommandHandler({
    store: runtime.store,
    turns: runtime.controller,
    conversationAttachments,
    attachmentResolver,
    providerTerminalResumes: { isActive: () => false },
    send: vi.fn(),
    broadcast: vi.fn(),
    broadcastSnapshot: vi.fn(),
  } as unknown as TurnInteractionCommandDependencies);
  const send = () => handler({} as never, {
    type: "message.send",
    requestId: randomUUID(),
    payload: {
      conversationId: runtime.conversationId,
      content: "Inspect this image.",
      attachments: [{ ...retained, path: retained.id }],
    },
  });
  const persistedFollowUps = () => runtime.store.conversationDetail(runtime.conversationId)
    ?.messages.filter(({ content }) => content === "Inspect this image.") ?? [];
  return { runtime, retained, conversationAttachments, attachmentResolver, send, persistedFollowUps };
}

describe("follow-up delivery uncertainty", () => {
  it("reports unknown delivery as ambiguous and retains images until the turn detaches", async () => {
    const { runtime, retained, conversationAttachments, attachmentResolver, send, persistedFollowUps } = await activeFollowUpRuntime();
    const steer = vi.spyOn(runtime.provider, "steer").mockRejectedValue(new ProviderSteerDeliveryUnknownError());

    await expect(send()).rejects.toMatchObject({
      delivery: "ambiguous",
      message: expect.stringContaining("did not confirm whether it received this follow-up"),
    });

    expect(steer).toHaveBeenCalledTimes(1);
    expect(persistedFollowUps()).toEqual([]);
    expect(conversationAttachments.acceptRetention).toHaveBeenCalledTimes(1);
    expect(conversationAttachments.releaseRetention).not.toHaveBeenCalled();
    expect(attachmentResolver.releaseAll).toHaveBeenCalledWith([retained.id]);
    expect(attachmentResolver.relinquishAll).not.toHaveBeenCalled();
    await flushTurnControllerTestPromises();
    expect(conversationAttachments.release).not.toHaveBeenCalled();

    runtime.provider.resolve();
    await flushTurnControllerTestPromises();
    expect(conversationAttachments.release).toHaveBeenCalledWith([retained.id]);
    runtime.store.close();
  });

  it("keeps an explicit provider rejection rejected and releases its retention", async () => {
    const { runtime, retained, conversationAttachments, attachmentResolver, send } = await activeFollowUpRuntime();
    vi.spyOn(runtime.provider, "steer").mockResolvedValue(false);

    const rejection = await send().catch((error: unknown) => error);

    expect(rejection).toMatchObject({ message: "This active agent route cannot accept a follow-up." });
    expect(rejection).not.toHaveProperty("delivery", "ambiguous");
    expect(conversationAttachments.acceptRetention).not.toHaveBeenCalled();
    expect(conversationAttachments.releaseRetention).toHaveBeenCalledTimes(1);
    expect(attachmentResolver.relinquishAll).toHaveBeenCalledWith([retained.id]);
    runtime.provider.resolve();
    await flushTurnControllerTestPromises();
    runtime.store.close();
  });

  it("keeps unknown delivery ambiguous when Stop arrives while the acknowledgement is pending", async () => {
    const { runtime, retained, conversationAttachments, send, persistedFollowUps } = await activeFollowUpRuntime();
    runtime.provider.deferOwnedStop();
    let lose!: () => void;
    const steer = vi.spyOn(runtime.provider, "steer").mockImplementation(async () => await new Promise<boolean>((_resolve, reject) => {
      lose = () => reject(new ProviderSteerDeliveryUnknownError());
    }));

    const sending = send();
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
    lose();

    await expect(sending).rejects.toMatchObject({ delivery: "ambiguous" });
    expect(persistedFollowUps()).toEqual([]);
    await flushTurnControllerTestPromises();
    expect(conversationAttachments.release).not.toHaveBeenCalled();

    runtime.provider.resolveOwnedStop();
    await flushTurnControllerTestPromises();
    expect(conversationAttachments.release).not.toHaveBeenCalled();
    runtime.provider.resolve({ status: "cancelled" });
    await flushTurnControllerTestPromises();
    expect(conversationAttachments.release).toHaveBeenCalledWith([retained.id]);
    expect(steer).toHaveBeenCalledTimes(1);
    runtime.store.close();
  });
});
