import { isAbsolute, join, normalize } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { parseCodexApprovalRequest } from "../../src/server/codex/approvals";
import { parseCodexPlan } from "../../src/server/codex/plans";
import { JsonLineDecoder } from "../../src/server/codex/protocol";
import { codexInputAnswers, parseCodexInputRequest } from "../../src/server/codex/questions";
import { completedReasoningSummary } from "../../src/server/codex/reasoning";
import { parseCodexTokenUsage } from "../../src/server/codex/usage";

describe("Codex protocol seams", () => {
  it("parses approval policy without coupling it to the transport", () => {
    const parsed = parseCodexApprovalRequest("item/commandExecution/requestApproval", {
      command: "npm test",
      cwd: "/workspace",
      reason: "Run verification",
      availableDecisions: ["accept", "decline"],
      additionalPermissions: { fileSystem: { read: ["/workspace"], write: ["/tmp"] } },
      networkApprovalContext: { host: "registry.npmjs.org", protocol: "https" },
    });

    expect(parsed).toMatchObject({
      protocol: "decision",
      request: {
        kind: "command",
        command: "npm test",
        cwd: "/workspace",
        reason: "Run verification",
        networkScope: { host: "registry.npmjs.org", protocol: "https" },
        permissionRoots: [
          { path: "/workspace", access: "read" },
          { path: "/tmp", access: "write" },
        ],
        availableDecisions: ["approve", "deny"],
      },
    });
  });

  it("normalizes absolute permission paths without rewriting provider display patterns", () => {
    const absoluteRoot = isAbsolute("C:\\workspace") ? "C:\\workspace" : "/workspace";
    const mixedAbsolutePath = `${absoluteRoot}/generated/../fixtures`;
    const parsed = parseCodexApprovalRequest("item/permissions/requestApproval", {
      permissions: {
        fileSystem: {
          read: [mixedAbsolutePath],
          entries: [
            { access: "read", path: { type: "glob_pattern", pattern: "src/**/{*.ts,*.tsx}" } },
            { access: "write", path: { type: "special", value: { kind: "project_root", subpath: "generated/**" } } },
          ],
        },
      },
    });

    expect(parsed?.request.permissionRoots).toEqual([
      { path: normalize(join(absoluteRoot, "fixtures")), access: "read" },
      { path: "glob: src/**/{*.ts,*.tsx}", access: "read" },
      { path: "project root: generated/**", access: "write" },
    ]);
  });

  it("parses and validates structured user questions", () => {
    const request = parseCodexInputRequest("item/tool/requestUserInput", {
      autoResolutionMs: 90_000,
      questions: [{
        id: "target",
        header: "Target",
        question: "Where should this run?",
        options: [{ label: "Local", description: "Use this computer" }],
      }],
    });

    expect(request).toMatchObject({
      autoResolutionMs: 90_000,
      questions: [{ id: "target", header: "Target", question: "Where should this run?" }],
    });
    expect(codexInputAnswers(request!, { target: ["Local"] })).toEqual({ target: { answers: ["Local"] } });
    expect(codexInputAnswers(request!, { target: [""] })).toBeUndefined();
  });

  it("keeps plan, reasoning, and usage projections independently testable", () => {
    expect(parseCodexPlan({
      explanation: "Do it safely",
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Change", status: "pending" },
        { step: "Ignored", status: "unknown" },
      ],
    })).toEqual({
      explanation: "Do it safely",
      steps: [
        { step: "Inspect", status: "completed" },
        { step: "Change", status: "pending" },
      ],
    });
    expect(completedReasoningSummary({ id: "r1", summary: [{ text: "Summary" }] }, new Set())).toBe("Summary");
    expect(completedReasoningSummary({ id: "r1", summary: [{ text: "Summary" }] }, new Set(["r1"]))).toBeUndefined();
    expect(parseCodexTokenUsage({
      last: { totalTokens: 120, inputTokens: 80, cachedInputTokens: 20, outputTokens: 40, reasoningOutputTokens: 10 },
      total: { totalTokens: 900 },
      modelContextWindow: 200_000,
    })).toEqual({
      usedTokens: 120,
      totalProcessedTokens: 900,
      totalProcessedScope: "thread",
      maxTokens: 200_000,
      inputTokens: 80,
      cachedInputTokens: 20,
      cacheWriteInputTokens: null,
      outputTokens: 40,
      reasoningOutputTokens: 10,
      compactsAutomatically: null,
    });
    expect(parseCodexTokenUsage({
      last: { totalTokens: 0, inputTokens: Number.NaN },
      total: { totalTokens: 1_200 },
      modelContextWindow: 0,
    })).toMatchObject({ usedTokens: 0, totalProcessedTokens: 1_200, maxTokens: 0, inputTokens: null });
    expect(parseCodexTokenUsage({ last: { totalTokens: Number.POSITIVE_INFINITY } })).toBeUndefined();
  });

  it("frames split UTF-8 JSONL and rejects oversized protocol lines", () => {
    const lines: string[] = [];
    const overflow = vi.fn();
    const decoder = new JsonLineDecoder(24, (line) => lines.push(line), overflow);
    const payload = Buffer.from('{"text":"héllo"}\n{"ok":true}\n', "utf8");
    decoder.push(payload.subarray(0, 11));
    decoder.push(payload.subarray(11));
    decoder.end();
    expect(lines).toEqual(['{"text":"héllo"}', '{"ok":true}']);

    const bounded = new JsonLineDecoder(4, vi.fn(), overflow);
    bounded.push(Buffer.from("oversized\n"));
    expect(overflow).toHaveBeenCalledOnce();
  });
});
