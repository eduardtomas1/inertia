import { describe, expect, it } from "vitest";
import { cursorSdkModelsSchema } from "../../src/node/cursor-sdk-models";

describe("Cursor SDK catalog boundary", () => {
  it("returns concrete identities without inventing capability or parameter support", () => {
    expect(cursorSdkModelsSchema.parse([{ id: "actual-model", displayName: "Actual model", variants: [{ params: ["high"] }] }]))
      .toEqual([{ id: "actual-model", displayName: "Actual model" }]);
  });
  it("rejects duplicate, malformed and oversized catalogs", () => {
    expect(() => cursorSdkModelsSchema.parse([{ id: "a", displayName: "A" }, { id: "a", displayName: "B" }])).toThrow();
    expect(() => cursorSdkModelsSchema.parse([{ id: "a\n", displayName: "A" }])).toThrow();
    expect(() => cursorSdkModelsSchema.parse(Array.from({ length: 513 }, (_, id) => ({ id: String(id), displayName: String(id) })))).toThrow();
  });
});
