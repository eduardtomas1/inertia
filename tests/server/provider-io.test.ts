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
