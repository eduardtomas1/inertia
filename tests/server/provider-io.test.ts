import { describe, expect, it } from "vitest";

import {
  ProviderNdjsonDecoder,
  ProviderRunEventBudget,
} from "../../src/server/provider/io";

describe("provider run event budget", () => {
  it("bounds NDJSON lines by UTF-8 bytes and recovers at the next line", () => {
    const lines: string[] = [];
    let overflows = 0;
    const decoder = new ProviderNdjsonDecoder(
      4,
      (line) => lines.push(line),
      () => { overflows += 1; },
    );
    const split = Buffer.from("é\n", "utf8");

    decoder.push(split.subarray(0, 1));
    decoder.push(split.subarray(1));
    decoder.push(Buffer.from("ééé\nok\n", "utf8"));
    decoder.end();

    expect(lines).toEqual(["é", "ok"]);
    expect(overflows).toBe(1);
  });

  it("bounds both event cardinality and UTF-8 bytes within one burst", () => {
    const countBudget = new ProviderRunEventBudget("Provider", 16, 2, 32);
    countBudget.observe("a");
    countBudget.observe("b");
    expect(() => countBudget.observe("c")).toThrow(
      "Provider exceeded the bounded event rate for this run.",
    );

    const byteBudget = new ProviderRunEventBudget("Provider", 16, 4, 8);
    byteBudget.observe("é");
    expect(() => byteBudget.observe("éé")).toThrow(
      "Provider exceeded the bounded event rate for this run.",
    );
    expect(() => new ProviderRunEventBudget(
      "Provider",
      4,
      4,
      16,
    ).observe("long")).toThrow("Provider sent an oversized event.");
  });

  it("replenishes burst capacity so long-lived runs do not exhaust a lifetime quota", () => {
    let now = 0;
    const budget = new ProviderRunEventBudget(
      "Provider",
      16,
      2,
      8,
      { windowMs: 1_000, now: () => now },
    );

    budget.observe("a");
    budget.observe("b");
    expect(() => budget.observe("c")).toThrow(/bounded event rate/u);

    now = 500;
    budget.observe("c");
    expect(() => budget.observe("d")).toThrow(/bounded event rate/u);

    now = 1_500;
    budget.observe("d");
    budget.observe("e");
  });

  it("rejects invalid event-budget limits", () => {
    expect(() => new ProviderRunEventBudget(
      "Provider",
      0,
      1,
      1,
    )).toThrow("The provider event budget is invalid.");
    expect(() => new ProviderRunEventBudget(
      "Provider",
      1,
      1,
      1,
      { windowMs: 0 },
    )).toThrow("The provider event budget is invalid.");
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
