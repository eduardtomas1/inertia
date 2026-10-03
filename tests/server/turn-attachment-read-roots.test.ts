import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { validateProviderRunInput } from "../../src/server/provider/adapters";
import { conversationAttachmentReadRoots } from "../../src/server/runtime/attachments/trusted-attachment-resolver";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  turnControllerTestAttachment,
} from "../support/turn-controller-runtime";
import { nativeProviderRunInput } from "./model-route-fixture";

afterEach(cleanupTurnControllerTestDirectories);

const STORE = join("/", "data", "conversation-attachments");
const OWN = "11111111-1111-4111-8111-111111111111";
const EARLIER = "33333333-3333-4333-8333-333333333333";
const OTHER_CHAT = "44444444-4444-4444-8444-444444444444";

describe("attachment read roots", () => {
  it("lists only the attachment directories of the requested conversation and its new turn", () => {
    const attachments = vi.fn((conversationId: string) => conversationId === "chat-a"
      ? [{ id: EARLIER }, { id: OWN }, { id: "not-an-id" }]
      : [{ id: OTHER_CHAT }]);
    const roots = conversationAttachmentReadRoots({ attachments }, { directory: STORE });
    expect(roots({ conversationId: "chat-a", attachmentIds: [OWN, "../escape"] }))
      .toEqual([join(STORE, EARLIER), join(STORE, OWN)]);
    expect(attachments).toHaveBeenCalledWith("chat-a");
    expect(roots({ conversationId: "chat-b", attachmentIds: [] })).toEqual([join(STORE, OTHER_CHAT)]);
  });

  it("passes the conversation's read roots to the provider run it starts", async () => {
    const readRoots = vi.fn(({ attachmentIds }: { conversationId: string; attachmentIds: readonly string[] }) =>
      attachmentIds.map((id) => join(STORE, id)));
    const runtime = await createTurnControllerTestRuntime({ attachmentReadRoots: readRoots });
    const attachment = await turnControllerTestAttachment(runtime, OWN, "notes.png");
    const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Read this.", attachments: [attachment] });
    runtime.controller.start(queued.turn.id);
    expect(readRoots).toHaveBeenCalledWith({ conversationId: runtime.conversationId, attachmentIds: [OWN] });
    expect(runtime.provider.input?.attachmentReadRoots).toEqual([join(STORE, OWN)]);
    runtime.provider.resolve({ text: "Done." });
    await runtime.controller.dispose();
    runtime.store.close();
  });

  it("rejects malformed read roots at the provider boundary", () => {
    const input = (attachmentReadRoots: string[]) => nativeProviderRunInput({
      providerId: "claude", conversationId: "conversation-1", cwd: "/workspace", prompt: "Read",
      interactionMode: "build", access: "supervised", attachmentReadRoots,
    });
    expect(validateProviderRunInput(input([join(STORE, OWN)]))).toBe("conversation-1");
    for (const malformed of ["relative/root", `${join(STORE, OWN)}\0`]) {
      expect(() => validateProviderRunInput(input([malformed]))).toThrow("An attachment read root is invalid.");
    }
    expect(() => validateProviderRunInput(input(Array.from({ length: 4_097 }, (_, index) => join(STORE, String(index))))))
      .toThrow("An attachment read root is invalid.");
  });
});
