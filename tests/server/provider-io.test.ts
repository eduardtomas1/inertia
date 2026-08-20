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

  it("replenishes burst capacity for long-lived runs", () => {
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

  it("retains cumulative event and byte ceilings across refill windows", () => {
    let now = 0;
    const countBudget = new ProviderRunEventBudget(
      "Provider",
      16,
      2,
      8,
      {
        windowMs: 1_000,
        now: () => now,
        maxRunEvents: 4,
        maxRunBytes: 16,
      },
    );
    countBudget.observe("a");
    countBudget.observe("b");
    expect(() => countBudget.observe("x")).toThrow(
      /bounded event rate/u,
    );
    now = 1_000;
    countBudget.observe("c");
    countBudget.observe("d");
    now = 2_000;
    expect(() => countBudget.observe("e")).toThrow(
      "Provider exceeded the bounded event budget for this run.",
    );

    now = 0;
    const byteBudget = new ProviderRunEventBudget(
      "Provider",
      16,
      4,
      8,
      {
        windowMs: 1_000,
        now: () => now,
        maxRunEvents: 8,
        maxRunBytes: 12,
      },
    );
    byteBudget.observe("é");
    byteBudget.observe("é");
    expect(() => byteBudget.observe("é")).toThrow(/bounded event rate/u);
    now = 1_000;
    byteBudget.observe("é");
    now = 2_000;
    expect(() => byteBudget.observe("é")).toThrow(
      "Provider exceeded the bounded event budget for this run.",
    );
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
    expect(() => new ProviderRunEventBudget(
      "Provider",
      1,
      2,
      2,
      { maxRunEvents: 1 },
    )).toThrow("The provider event budget is invalid.");
    expect(() => new ProviderRunEventBudget(
      "Provider",
      1,
      2,
      2,
      { maxRunBytes: 1 },
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
