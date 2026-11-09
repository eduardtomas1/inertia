import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateSessions,
  analyzeClaudeProjects,
  classifyTranscriptHead,
  formatUsageReport,
  groupMetrics,
  summarizeTranscriptLines,
  weighUsage,
} from "../../scripts/claude-usage-report.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function assistant(id: string, at: string, usage: Record<string, unknown>, model = "claude-opus-5-5"): string {
  return JSON.stringify({ type: "assistant", timestamp: at, message: { id, model, usage } });
}

function user(entrypoint: string, text: string): string {
  return JSON.stringify({ type: "user", entrypoint, message: { role: "user", content: text } });
}

function compaction(at: string, trigger: string, preTokens: number): string {
  return JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: at, compactMetadata: { trigger, preTokens } });
}

describe("Claude usage report", () => {
  it("tells Inertia and T3 Code transcripts apart by their tool and skill markers", () => {
    expect(classifyTranscriptHead("Skill(inertia-selected-skills:file-pr) {\"name\":\"mcp__inertia-chat-manager__inertia_browser_click\"}")).toBe("inertia");
    expect(classifyTranscriptHead("deferred: mcp__t3-code__t3_thread_list, mcp__t3-code__t3_thread_read")).toBe("t3-code");
    expect(classifyTranscriptHead("plain Claude Code session")).toBe("other");
  });

  it("weighs cache writes by their reported lifetime and treats an unsplit write as one hour", () => {
    expect(weighUsage({
      input_tokens: 10,
      cache_read_input_tokens: 1_000,
      cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
      output_tokens: 20,
    })).toBe(10 + 100 + 125 + 400 + 100);
    expect(weighUsage({ cache_creation_input_tokens: 50 })).toBe(100);
  });

  it("keeps the final usage of a streamed message once and skips synthetic messages", () => {
    const summary = summarizeTranscriptLines([
      user("sdk-ts", "hello"),
      assistant("m1", "2026-11-01T10:00:00Z", { cache_read_input_tokens: 10, output_tokens: 1 }),
      assistant("m1", "2026-11-01T10:00:01Z", { cache_read_input_tokens: 10, output_tokens: 7 }),
      assistant("m2", "2026-11-01T10:00:05Z", { output_tokens: 3 }, "<synthetic>"),
      compaction("2026-11-01T10:05:00Z", "auto", 950_000),
      "not json",
    ]);
    expect(summary.entrypoint).toBe("sdk-ts");
    expect(summary.calls).toHaveLength(1);
    expect(summary.calls[0]?.usage.output_tokens).toBe(7);
    expect(summary.compactions).toEqual([{ at: "2026-11-01T10:05:00Z", trigger: "auto", preTokens: 950_000 }]);
  });

  it("separates idle rebuilds after an hour from rebuilds after a few minutes and counts large contexts", () => {
    const calls = [
      { at: "2026-11-01T10:00:00Z", model: "m", usage: { cache_creation_input_tokens: 30_000, output_tokens: 10 } },
      { at: "2026-11-01T10:01:00Z", model: "m", usage: { cache_read_input_tokens: 450_000, output_tokens: 10 } },
      { at: "2026-11-01T11:30:00Z", model: "m", usage: { cache_creation_input_tokens: 460_000, output_tokens: 10 } },
      { at: "2026-11-01T11:40:00Z", model: "m", usage: { cache_creation_input_tokens: 470_000, output_tokens: 10 } },
      { at: "2026-11-01T11:41:00Z", model: "m", usage: { cache_creation_input_tokens: 10_000, cache_read_input_tokens: 470_000, output_tokens: 10 } },
    ];
    const groups = aggregateSessions([{ app: "inertia", subagent: false, entrypoint: "sdk-ts", calls, compactions: [] }]);
    const metrics = groupMetrics(groups["inertia:main"]!);
    expect(metrics.calls).toBe(5);
    expect(metrics.largeContextShare).toBe(4 / 5);
    expect(metrics.rebuilds.afterHour.count).toBe(1);
    expect(metrics.rebuilds.afterMinutes.count).toBe(1);
    expect(metrics.rebuilds.quick.count).toBe(0);
    expect(metrics.weightedPerOutputToken).toBeCloseTo(metrics.weightedTokens / 50, 0);
  });

  it("reads a projects folder, attributes subagents to their parent's app and honours the time window", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-usage-report-"));
    roots.push(root);
    const project = join(root, "-home-user-project");
    mkdirSync(join(project, "inertia-session", "subagents"), { recursive: true });
    writeFileSync(join(project, "inertia-session.jsonl"), [
      user("sdk-ts", "Skill(inertia-selected-skills:file-pr)"),
      assistant("a1", "2026-10-01T09:00:00Z", { cache_read_input_tokens: 100_000, output_tokens: 100 }),
      assistant("a2", "2026-11-01T09:00:00Z", { cache_read_input_tokens: 200_000, output_tokens: 100 }),
      compaction("2026-11-01T09:10:00Z", "manual", 210_000),
    ].join("\n"));
    writeFileSync(join(project, "inertia-session", "subagents", "agent-1.jsonl"), [
      assistant("s1", "2026-11-01T09:05:00Z", { cache_creation_input_tokens: 40_000, output_tokens: 50 }),
    ].join("\n"));
    writeFileSync(join(project, "t3-session.jsonl"), [
      user("t3-code", "tools: mcp__t3-code__t3_thread_read"),
      assistant("t1", "2026-11-02T09:00:00Z", { cache_read_input_tokens: 50_000, output_tokens: 10 }),
    ].join("\n"));

    const report = await analyzeClaudeProjects({ root, since: "2026-10-15T00:00:00Z", until: "2026-11-05T00:00:00Z" });

    expect(Object.keys(report.groups)).toEqual(["inertia:main", "inertia:subagent", "t3-code:main"]);
    expect(report.groups["inertia:main"]).toMatchObject({ sessions: 1, calls: 1, compactions: 1, averageTokensAtCompaction: 210_000 });
    expect(report.groups["inertia:subagent"]).toMatchObject({ sessions: 1, calls: 1, weightedTokens: 80_250 });
    expect(report.groups["t3-code:main"]).toMatchObject({ sessions: 1, calls: 1 });
    const text = formatUsageReport(report);
    expect(text).toContain("inertia:main");
    expect(text).toContain("1 at 210K");
  });
});
