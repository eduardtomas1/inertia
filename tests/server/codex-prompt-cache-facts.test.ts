import { describe, expect, it } from "vitest";

import { createCodexPromptCacheClock, parseCodexTokenUsage } from "../../src/server/codex/usage";

describe("Codex prompt cache facts", () => {
  it("assumes the 30-minute cache from the time of each usage report", () => {
    let now = Date.parse("2026-10-25T09:00:00.000Z");
    const clock = createCodexPromptCacheClock(() => new Date(now));
    const usage = parseCodexTokenUsage({ last: { totalTokens: 210_000 }, total: { totalTokens: 400_000 }, modelContextWindow: 400_000 })!;
    now += 20_000;
    expect(clock.attach(usage)).toEqual({
      ...usage,
      promptCache: { lastRequestStartedAt: "2026-10-25T09:00:20.000Z", lifetimeMs: 1_800_000, source: "assumed" },
    });
    now += 300_000;
    expect(clock.attach(usage).promptCache).toEqual({
      lastRequestStartedAt: "2026-10-25T09:05:20.000Z",
      lifetimeMs: 1_800_000,
      source: "assumed",
    });
  });

  it("leaves the parsed usage unchanged", () => {
    const usage = parseCodexTokenUsage({ last: { totalTokens: 1 } })!;
    createCodexPromptCacheClock().attach(usage);
    expect(usage).not.toHaveProperty("promptCache");
  });
});
