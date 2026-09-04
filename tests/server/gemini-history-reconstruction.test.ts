// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import type { ChatMessage } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { BUILD_MODE_INSTRUCTION } from "../../src/server/runtime/turns/request-context";
import { reconstructedVisibleHistory } from "../../src/server/runtime/turns/turn-request-preparation";
import { geminiPromptWithReconstructedHistory } from
  "../../src/server/provider/gemini-acp-session";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestIdentity,
  turnControllerTestProviderInfo,
} from "../support/turn-controller-runtime";

function message(
  index: number,
  role: ChatMessage["role"],
  content: string,
  turnId: string | null = `turn-${index}`,
): ChatMessage {
  return {
    id: `message-${index}`,
    conversationId: "gemini-conversation",
    turnId,
    role,
    content,
    attachments: [],
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  };
}

describe("Gemini visible-history reconstruction", () => {
  afterEach(cleanupTurnControllerTestDirectories);

  it("includes only turn-owned visible user and assistant messages in order", () => {
    expect(reconstructedVisibleHistory([
      message(0, "system", "internal instruction", null),
      message(1, "user", "first request"),
      message(2, "assistant", "first answer"),
      message(3, "assistant", "conversation-scoped artifact", null),
      message(4, "user", ""),
      message(5, "user", "current unassociated input", null),
    ])).toEqual({
      source: "visible-transcript",
      truncated: false,
      messages: [
        { role: "user", content: "first request" },
        { role: "assistant", content: "first answer" },
      ],
    });
  });

  it("retains the newest 64 messages and marks count truncation", () => {
    const history = reconstructedVisibleHistory(
      Array.from({ length: 70 }, (_, index) => message(
        index,
        index % 2 === 0 ? "user" : "assistant",
        `content-${index}`,
      )),
    );
    expect(history).toMatchObject({ truncated: true });
    expect(history?.messages).toHaveLength(64);
    expect(history?.messages[0]?.content).toBe("content-6");
    expect(history?.messages.at(-1)?.content).toBe("content-69");
  });

  it("bounds individual and aggregate text while preserving recent context", () => {
    const history = reconstructedVisibleHistory([
      message(0, "user", "a".repeat(30 * 1024)),
      message(1, "assistant", "b".repeat(70 * 1024)),
      message(2, "user", "newest"),
    ]);
    expect(history?.truncated).toBe(true);
    expect(history?.messages.at(-1)?.content).toBe("newest");
    expect(history?.messages.every(({ content }) => content.length <= 24 * 1024))
      .toBe(true);
    expect(history?.messages.reduce((sum, { content }) => sum + content.length, 0))
      .toBeLessThanOrEqual(96 * 1024);
    expect(history?.messages[0]?.content).toContain(
      "historical message truncated by Inertia",
    );
  });

  it("omits reconstructed context when no eligible history exists", () => {
    expect(reconstructedVisibleHistory([
      message(0, "system", "hidden", null),
      message(1, "user", "draft", null),
    ])).toBeUndefined();
  });

  it("discloses that explicitly entered sensitive text remains visible context", () => {
    const prompt = geminiPromptWithReconstructedHistory("Continue", {
      source: "visible-transcript",
      truncated: false,
      messages: [{ role: "user", content: "user-entered-secret" }],
    });

    expect(prompt).toContain("user-entered-secret");
    expect(prompt).toContain(
      "Text explicitly entered into visible messages is included",
    );
    expect(prompt).toContain("provider-managed credential state");
  });

  it("continues through application context without persisting a native session", async () => {
    const staleGeminiCatalog = {
      ...turnControllerTestProviderInfo(),
      id: "gemini" as const,
      label: "Gemini",
      command: "gemini",
      models: [{
        ...turnControllerTestProviderInfo().models[0]!,
        id: "gemini-stale-default",
        label: "Stale cached default",
      }],
    };
    const runtime = await createTurnControllerTestRuntime({
      providerInfo: () => [staleGeminiCatalog],
    }, {
      modelSelection: providerNativeModelSelection({
        providerId: "gemini",
        modelId: "provider-default",
      }),
    });
    const first = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Implement the first Gemini change.",
    });
    expect(first.turn.providerSessionBefore).toBeNull();
    expect(first.turn.model).toBe("provider-default");
    expect(runtime.controller.start(first.turn.id)).toBe(true);
    expect(runtime.provider.input).toMatchObject({
      providerId: "gemini",
      model: undefined,
      modelSelection: { modelId: "provider-default" },
      sessionId: undefined,
      reconstructedHistory: undefined,
    });
    runtime.provider.emit({
      ...turnControllerTestIdentity(runtime),
      type: "text",
      text: "The first Gemini answer.",
    });
    runtime.provider.resolve({
      status: "completed",
      text: "The first Gemini answer.",
    });
    await flushTurnControllerTestPromises();
    expect(runtime.store.conversation(runtime.conversationId).providerSessionId)
      .toBeNull();

    const second = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Validate the follow-up.",
    });
    expect(second.turn.providerSessionBefore).toBeNull();
    expect(runtime.controller.start(second.turn.id)).toBe(true);
    expect(runtime.provider.input).toMatchObject({
      providerId: "gemini",
      sessionId: undefined,
      reconstructedHistory: {
        source: "visible-transcript",
        truncated: false,
        messages: [
          { role: "user", content: "Implement the first Gemini change." },
          { role: "assistant", content: "The first Gemini answer." },
        ],
      },
    });
    expect(runtime.provider.input?.reconstructedHistory?.messages)
      .toEqual(expect.not.arrayContaining([
        expect.objectContaining({
          content: expect.stringContaining(BUILD_MODE_INSTRUCTION),
        }),
      ]));
    runtime.provider.resolve({ status: "completed", text: "Validated." });
    await flushTurnControllerTestPromises();
    expect(runtime.store.conversation(runtime.conversationId).providerSessionId)
      .toBeNull();
    runtime.store.close();
  });
});
