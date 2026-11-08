import { describe, expect, it } from "vitest";
import { modelSelectionSchema, providerNativeModelSelection } from "../../src/shared/model-routing";
import { cursorSdkModelRoute } from "../../src/renderer/src/components/cursor-sdk/cursorSdkModelRoute";

describe("explicit Cursor SDK model route", () => {
  it("uses the actual selection contract with a concrete discovered identity", () => {
    const route = cursorSdkModelRoute({ id: "synthetic-model", displayName: "Synthetic model" })!;
    expect(modelSelectionSchema.parse(route.selection)).toMatchObject({
      harnessId: "cursor-sdk", backendProfileId: "builtin:cursor", modelId: "synthetic-model",
      alias: null, reasoningEffort: null, contextWindowOverride: null, providerOptions: {}, capabilities: [],
    });
    expect(route.selectable).toBe(true);
    expect(providerNativeModelSelection({ providerId: "cursor", modelId: "synthetic-model" }).harnessId).toBe("cursor-acp");
  });
  it.each(["", " ", "default", "provider-default"])("refuses non-concrete ID %j", (id) => {
    expect(cursorSdkModelRoute({ id, displayName: "Synthetic default" })).toBeNull();
  });
});
