// @inertia-test-suite portable
import type { ClientContext, SessionConfigOption } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import type { ProviderModel } from "../../src/shared/contracts";
import { createAgentHarnessEmitter } from "../../src/server/provider/agent-harness";
import { emitCursorMetadata } from "../../src/server/provider/cursor-acp-metadata";
import { configureCursorSession } from "../../src/server/provider/cursor-acp-session";

function config(model: string): SessionConfigOption[] {
  const effort = model === "model-a" ? "high" : "low";
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: model,
      options: [{ value: "model-a", name: "A" }, { value: "model-b", name: "B" }] },
    { id: "effort", name: "Reasoning", category: "thought_level", type: "select", currentValue: effort,
      options: [{ value: effort, name: effort }] },
  ];
}

function models(options: SessionConfigOption[]): ProviderModel[] {
  let catalog: ProviderModel[] = [];
  const emitter = createAgentHarnessEmitter("cursor", "model-switch", {
    onEvent: (event) => {
      if (event.type === "extension" && event.event.type === "metadata") {
        catalog = event.event.metadata.models ?? [];
      }
    },
  }, "model-switch-run", "model-switch-turn");
  emitCursorMetadata(options, false, emitter);
  return catalog;
}

describe("Cursor model-dependent reasoning", () => {
  it("switches to an unobserved model with its own default, then publishes its reasoning choices", async () => {
    const advertised = models(config("model-a"));
    expect(advertised[0]).toMatchObject({ defaultReasoningEffort: "high" });
    expect(advertised[1]).toMatchObject({ defaultReasoningEffort: "", reasoningOptions: [] });
    const requests: unknown[] = [];
    const context = {
      request: async (method: string, payload: { configId: string; value: string }) => {
        requests.push({ method, payload });
        // The peer changes reasoning options when the model changes (ACP 1.4).
        expect(payload).toMatchObject({ configId: "model", value: "model-b" });
        return { configOptions: config("model-b") };
      },
    } as unknown as ClientContext;
    const configured = await configureCursorSession(
      context, "session", undefined, config("model-a"), "build", "model-b",
      advertised[1]!.defaultReasoningEffort || undefined,
    );
    expect(requests).toHaveLength(1);
    const refreshed = models(configured);
    expect(refreshed[1]).toMatchObject({
      defaultReasoningEffort: "low", reasoningOptions: [{ value: "low" }],
    });
    expect(refreshed[0]).toMatchObject({ defaultReasoningEffort: "", reasoningOptions: [] });
  });

  it("still rejects an explicit incompatible effort instead of silently replacing the user choice", async () => {
    const context = {
      request: async () => ({ configOptions: config("model-b") }),
    } as unknown as ClientContext;
    await expect(configureCursorSession(
      context, "session", undefined, config("model-a"), "build", "model-b", "high",
    )).rejects.toThrow("Cursor ACP does not advertise the selected reasoning effort 'high'.");
  });
});
