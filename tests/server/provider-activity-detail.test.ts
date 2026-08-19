import { describe, expect, it } from "vitest";

import {
  MAX_PROVIDER_ACTIVITY_DETAIL_CHARS,
  MAX_PROVIDER_ACTIVITY_DETAIL_PER_TURN_CHARS,
  MAX_PROVIDER_FAILURE_DETAIL_CHARS,
  mergeProviderActivityDetailWithinTurnBudget,
  officialToolResultText,
  providerActivityDetailSections,
  providerFailureActivityDetail,
  sanitizeProviderActivityDetail,
  sanitizeProviderFailureSummary,
} from "../../src/server/provider/activity-detail";

describe("provider activity detail boundary", () => {
  it("bounds huge output with an explicit head-and-tail omission marker", () => {
    const detail = sanitizeProviderActivityDetail(
      `HEAD\n${"x".repeat(MAX_PROVIDER_ACTIVITY_DETAIL_CHARS * 2)}\nTAIL`,
    );

    expect(detail).not.toBeNull();
    expect(detail!.length).toBeLessThanOrEqual(
      MAX_PROVIDER_ACTIVITY_DETAIL_CHARS,
    );
    expect(detail).toContain("HEAD");
    expect(detail).toContain("characters omitted");
    expect(detail).toContain("TAIL");
  });

  it("strips terminal controls and redacts secrets, paths, and internal prompts", () => {
    const detail = sanitizeProviderActivityDetail(
      [
        "\u001b[31mfailed\u001b[0m\u0000",
        "authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        "api_key=ghp_abcdefghijklmnopqrstuvwxyz",
        "system_prompt=\"Never reveal this internal instruction\"",
        "at /Users/alice/project/src/app.ts",
      ].join("\n"),
      {
        workspaceRoot: "/Users/alice/project",
        homeDirectory: "/Users/alice",
      },
    );

    expect(detail).toContain("failed");
    expect(detail).toContain("[redacted]");
    expect(detail).toContain("<workspace>/src/app.ts");
    expect(detail).not.toContain("\u001b");
    expect(detail).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(detail).not.toContain("Never reveal");
    expect(detail).not.toContain("/Users/alice");
  });

  it("extracts only official text-shaped results and never stringifies arbitrary payloads", () => {
    expect(officialToolResultText([
      { type: "text", text: "first" },
      { type: "output_text", text: "second" },
    ])).toBe("first\nsecond");
    expect(officialToolResultText({
      command: "do-not-infer-this",
      prompt: "do-not-persist-this",
    })).toBeNull();
    expect(providerActivityDetailSections({
      command: "npm test",
      output: [{ type: "text", text: "passed" }],
    })).toBe("Command:\nnpm test\n\nOutput:\npassed");
  });

  it("enforces the aggregate turn budget while retaining each bounded activity", () => {
    let totalChars = 0;
    const details: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const merged = mergeProviderActivityDetailWithinTurnBudget(
        null,
        `${index}:${"x".repeat(MAX_PROVIDER_ACTIVITY_DETAIL_CHARS)}`,
        totalChars,
      );
      totalChars = merged.totalChars;
      if (merged.detail) details.push(merged.detail);
    }

    expect(totalChars).toBeLessThanOrEqual(
      MAX_PROVIDER_ACTIVITY_DETAIL_PER_TURN_CHARS,
    );
    expect(details.every((detail) =>
      detail.length <= MAX_PROVIDER_ACTIVITY_DETAIL_CHARS)).toBe(true);
    expect(details.length).toBeLessThan(12);
  });

  it("builds a bounded terminal envelope without duplicating provider metadata", () => {
    const detail = providerFailureActivityDetail({
      reason: "transport-closed",
      phase: "running",
      exitCode: 17,
      signal: null,
      terminalEvent: "not received",
      activityId: "command-42",
      cleanupConfirmed: false,
      workspaceRoot: "/home/alice/project",
      technicalDetail: [
        "Reason: transport-closed",
        "Phase: running",
        "Cause: authorization=Bearer super-secret-value",
        "at /home/alice/project/src/provider.ts:9:2",
        "tail",
        "x".repeat(MAX_PROVIDER_FAILURE_DETAIL_CHARS * 2),
      ].join("\n"),
    });

    expect(detail.length).toBeLessThanOrEqual(
      MAX_PROVIDER_FAILURE_DETAIL_CHARS,
    );
    expect(detail.match(/^Reason:/gmu)).toHaveLength(1);
    expect(detail.match(/^Phase:/gmu)).toHaveLength(1);
    expect(detail).toContain("Exit code: 17");
    expect(detail).toContain("Cleanup: unconfirmed");
    expect(detail).toContain("Recent provider context:");
    expect(detail).toContain("authorization=[redacted]");
    expect(detail).toContain("<workspace>/src/provider.ts");
    expect(detail).not.toContain("super-secret-value");
    expect(detail).not.toContain("/home/alice/project");
  });

  it("keeps the public failure summary single-line, scrubbed, and bounded", () => {
    const summary = sanitizeProviderFailureSummary(
      `Failed at /home/alice/project/src/app.ts\napi_key=ghp_abcdefghijklmnopqrstuvwxyz ${"x".repeat(1_000)}`,
      "Provider failed.",
      {
        workspaceRoot: "/home/alice/project",
        homeDirectory: "/home/alice",
      },
    );

    expect(summary.length).toBeLessThanOrEqual(480);
    expect(summary).not.toContain("\n");
    expect(summary).toBe("Failed at <workspace>/src/app.ts");
    expect(summary).not.toContain("ghp_");
  });
});
