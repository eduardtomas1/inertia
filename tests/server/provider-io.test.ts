import { describe, expect, it } from "vitest";

import { ProviderRunEventBudget } from "../../src/server/provider/io";

describe("provider run event budget", () => {
  it("bounds both event cardinality and aggregate UTF-8 bytes", () => {
    const countBudget = new ProviderRunEventBudget("Provider", 16, 2, 32);
    countBudget.observe("a");
    countBudget.observe("b");
    expect(() => countBudget.observe("c")).toThrow(
      "Provider exceeded the bounded event budget for this run.",
    );

    const byteBudget = new ProviderRunEventBudget("Provider", 16, 4, 8);
    byteBudget.observe("é");
    expect(() => byteBudget.observe("éé")).toThrow(
      "Provider exceeded the bounded event budget for this run.",
    );
    expect(() => new ProviderRunEventBudget(
      "Provider",
      4,
      4,
      16,
    ).observe("long")).toThrow("Provider sent an oversized event.");
  });

  it("fails closed for values that cannot be serialized", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => new ProviderRunEventBudget(
      "Provider",
      16,
      4,
      64,
    ).observe(circular)).toThrow("Provider sent an unserializable event.");
    expect(() => new ProviderRunEventBudget(
      "Provider",
      16,
      4,
      64,
    ).observe(undefined)).toThrow("Provider sent an unserializable event.");
  });
});
