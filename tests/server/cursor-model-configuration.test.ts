// @inertia-test-suite portable
import type { ClientContext, SessionConfigOption } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import type { ProviderModel } from "../../src/shared/contracts";
import { createAgentHarnessEmitter } from "../../src/server/provider/agent-harness";
import { emitCursorMetadata } from "../../src/server/provider/cursor-acp-metadata";
import { configureCursorSession } from "../../src/server/provider/cursor-acp-session";

function configuration(currentValue: string): SessionConfigOption[] {
  return [{
    id: "model", name: "Model", category: "model", type: "select", currentValue,
    options: [{ value: "reasoner", name: "Reasoner" }, { value: "plain", name: "Plain" }],
  }, ...(currentValue === "reasoner" ? [{
    id: "effort", name: "Effort", category: "thought_level", type: "select" as const,
    currentValue: "high", options: [{ value: "high", name: "High" }],
  }] : [])];
}

function models(options: SessionConfigOption[]): ProviderModel[] {
  let result: ProviderModel[] = [];
  const emitter = createAgentHarnessEmitter("cursor", "chat", {
    onEvent: (event) => {
      if (event.type === "extension" && event.event.type === "metadata") {
        result = event.event.metadata.models ?? [];
      }
    },
  }, "run", "turn");
  emitCursorMetadata(options, false, emitter);
  return result;
}

describe("Cursor model-scoped configuration", () => {
  it("only advertises effort for the model whose session options were observed", () => {
    expect(models(configuration("reasoner"))).toMatchObject([
      { id: "reasoner", reasoningOptions: [{ value: "high" }], defaultReasoningEffort: "high" },
      { id: "plain", reasoningOptions: [], defaultReasoningEffort: "" },
    ]);
    expect(models(configuration("plain"))).toMatchObject([
      { id: "reasoner", reasoningOptions: [], defaultReasoningEffort: "" },
      { id: "plain", reasoningOptions: [], defaultReasoningEffort: "" },
    ]);
  });

  it("can select a model without thinking using its advertised default", async () => {
    const initial = configuration("reasoner");
    const selected = models(initial).find(({ id }) => id === "plain")!;
    const request = vi.fn(async () => ({ configOptions: configuration("plain") }));
    const result = await configureCursorSession(
      { request } as unknown as ClientContext,
      "session", null, initial, "build", selected.id, selected.defaultReasoningEffort,
    );
    expect(result).toEqual(configuration("plain"));
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]).toBeDefined();
  });

  it("still rejects an explicitly requested effort missing from the new model", async () => {
    const request = vi.fn(async () => ({ configOptions: configuration("plain") }));
    await expect(configureCursorSession(
      { request } as unknown as ClientContext,
      "session", null, configuration("reasoner"), "build", "plain", "high",
    )).rejects.toThrow("does not advertise the selected reasoning effort");
  });
});
