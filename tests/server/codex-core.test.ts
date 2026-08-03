import { isAbsolute, normalize } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { CODEX_APP_SERVER_MAX_FRAME_BYTES } from "../../src/server/codex-app-server";
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
    expect(parseCodexApprovalRequest(
      "item/commandExecution/requestApproval",
      {
        command: "npm test",
        cwd: "/workspace",
        reason: "Run the focused suite.\nThen report failures.",
      },
    )?.request.reason).toBe(
      "Run the focused suite.\nThen report failures.",
    );
  });

  it("represents installed legacy supervised approvals without exposing patch content", () => {
    expect(parseCodexApprovalRequest("execCommandApproval", {
      conversationId: "thread-legacy",
      callId: "command-1",
      command: ["printf", "emoji: 😀 and spaces"],
      parsedCmd: [],
      cwd: "/workspace",
      reason: "Verify output",
    })).toMatchObject({
      protocol: "legacy-review",
      providerThreadId: "thread-legacy",
      request: {
        kind: "command",
        command: "printf \"emoji: 😀 and spaces\"",
        detail: "printf \"emoji: 😀 and spaces\"",
        availableDecisions: ["approve", "deny", "cancel"],
      },
    });

    const patch = parseCodexApprovalRequest("applyPatchApproval", {
      conversationId: "thread-legacy",
      callId: "patch-1",
      fileChanges: {
        "src/secret.ts": { type: "add", content: "credential-value" },
      },
      grantRoot: "/workspace",
      reason: "Apply the requested edit",
    });
    expect(patch).toMatchObject({
      protocol: "legacy-review",
      providerThreadId: "thread-legacy",
      request: {
        kind: "file-change",
        detail: "Apply the requested edit\nChange src/secret.ts",
        permissionRoots: [{ path: "/workspace", access: "write" }],
      },
    });
    expect(JSON.stringify(patch)).not.toContain("credential-value");

    const movedPatch = parseCodexApprovalRequest("applyPatchApproval", {
      conversationId: "thread-legacy",
      callId: "patch-move",
      fileChanges: {
        "src/original.ts": {
          type: "update",
          unified_diff: "@@ -1 +1 @@",
          move_path: "src/destination.ts",
        },
        "src/second.ts": { type: "delete", content: "hidden" },
      },
      grantRoot: "/workspace",
    });
    expect(movedPatch?.request.detail).toBe(
      "Change src/original.ts\nMove to src/destination.ts\nChange src/second.ts",
    );
    expect(JSON.stringify(movedPatch)).not.toContain("@@ -1 +1 @@");
  });

  it("preserves exact absolute permission paths and provider display patterns", () => {
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
      { path: mixedAbsolutePath, access: "read" },
      { path: "glob: src/**/{*.ts,*.tsx}", access: "read" },
      { path: "project root: generated/**", access: "write" },
    ]);
    expect(parsed?.requestedPermissions).toEqual({
      fileSystem: {
        read: [mixedAbsolutePath],
        entries: [
          {
            access: "read",
            path: {
              type: "glob_pattern",
              pattern: "src/**/{*.ts,*.tsx}",
            },
          },
          {
            access: "write",
            path: {
              type: "special",
              value: { kind: "project_root", subpath: "generated/**" },
            },
          },
        ],
      },
    });
  });

  it("fails closed when a permission grant cannot be displayed completely", () => {
    const roots = Array.from(
      { length: 13 },
      (_, index) => normalize(`/workspace/root-${index}`),
    );

    expect(parseCodexApprovalRequest("item/permissions/requestApproval", {
      permissions: {
        fileSystem: { read: roots, write: null, entries: [] },
      },
    })).toBeUndefined();
    expect(parseCodexApprovalRequest("execCommandApproval", {
      conversationId: "thread-legacy",
      callId: "command-1",
      command: ["npm", "test\nunsafe"],
      parsedCmd: [],
      cwd: "/workspace",
    })).toBeUndefined();
    expect(parseCodexApprovalRequest("applyPatchApproval", {
      conversationId: "thread-legacy",
      callId: "patch-1",
      fileChanges: {
        "src/file.ts": { type: "future-change", content: "hidden" },
      },
      grantRoot: "/workspace",
    })).toBeUndefined();
    expect(parseCodexApprovalRequest("applyPatchApproval", {
      conversationId: "thread-legacy",
      callId: "patch-too-large-to-display",
      fileChanges: Object.fromEntries(Array.from(
        { length: 256 },
        (_, index) => [
          `src/${index}-${"x".repeat(20)}.ts`,
          { type: "add", content: "hidden" },
        ],
      )),
      grantRoot: "/workspace",
    })).toBeUndefined();
    expect(parseCodexApprovalRequest("item/permissions/requestApproval", {
      permissions: {
        fileSystem: {
          read: ["/workspace"],
          entries: [{
            access: "write",
            path: { type: "future_permission", path: "/private" },
          }],
        },
      },
    })).toBeUndefined();
    expect(parseCodexApprovalRequest("item/permissions/requestApproval", {
      permissions: {
        fileSystem: { read: ["/workspace"] },
        futureGrant: { enabled: true },
      },
    })).toBeUndefined();
    expect(parseCodexApprovalRequest("item/commandExecution/requestApproval", {
      command: `echo ${"x".repeat(4_000)}`,
      cwd: "/workspace",
    })).toBeUndefined();
    expect(parseCodexApprovalRequest("item/commandExecution/requestApproval", {
      command: "npm test",
      cwd: "relative-workspace",
    })).toBeUndefined();
    expect(parseCodexApprovalRequest("item/commandExecution/requestApproval", {
      command: "curl example.test",
      networkApprovalContext: {
        host: "example.test",
        protocol: "future-protocol",
      },
    })).toBeUndefined();
    expect(parseCodexApprovalRequest("item/commandExecution/requestApproval", {
      command: "curl example.test",
      networkApprovalContext: {
        host: "example.test",
        protocol: "https",
        scope: "future-session",
      },
    })).toBeUndefined();
    expect(parseCodexApprovalRequest("item/commandExecution/requestApproval", {
      command: "npm test",
      availableDecisions: ["accept", "future-decision"],
    })).toBeUndefined();
    expect(parseCodexApprovalRequest("item/permissions/requestApproval", {
      permissions: {
        fileSystem: {
          read: ["/workspace/link/../secret"],
        },
      },
    })?.requestedPermissions).toEqual({
      fileSystem: {
        read: ["/workspace/link/../secret"],
      },
    });
    expect(parseCodexApprovalRequest("item/permissions/requestApproval", {
      permissions: {
        fileSystem: {
          read: ["/workspace/trailing-space "],
        },
      },
    })?.request.permissionRoots).toEqual([
      { path: "/workspace/trailing-space ", access: "read" },
    ]);
    expect(parseCodexApprovalRequest("item/permissions/requestApproval", {
      permissions: {
        fileSystem: {
          read: ["/workspace/line\nbreak"],
        },
      },
    })).toBeUndefined();
    for (const controlCharacter of ["\t", "\u001b", "\u007f"]) {
      expect(parseCodexApprovalRequest(
        "item/commandExecution/requestApproval",
        {
          command: `npm${controlCharacter}test`,
          cwd: "/workspace",
        },
      )).toBeUndefined();
      expect(parseCodexApprovalRequest(
        "item/permissions/requestApproval",
        {
          permissions: {
            fileSystem: {
              entries: [{
                access: "read",
                path: {
                  type: "glob_pattern",
                  pattern: `src/${controlCharacter}*.ts`,
                },
              }],
            },
          },
        },
      )).toBeUndefined();
    }
    for (const unsafeFormatting of [
      "\u0085",
      "\u2028",
      "\u2029",
      "\u202e",
      "\u2066",
    ]) {
      expect(parseCodexApprovalRequest("execCommandApproval", {
        conversationId: "thread-legacy",
        callId: "command-formatting",
        command: ["printf", `safe${unsafeFormatting}echo injected`],
        parsedCmd: [],
        cwd: "/workspace",
      })).toBeUndefined();
      expect(parseCodexApprovalRequest("applyPatchApproval", {
        conversationId: "thread-legacy",
        callId: "patch-directional-source",
        fileChanges: {
          [`src/safe${unsafeFormatting}cod.exe`]: {
            type: "delete",
            content: "hidden",
          },
        },
        grantRoot: "/workspace",
      })).toBeUndefined();
      expect(parseCodexApprovalRequest("applyPatchApproval", {
        conversationId: "thread-legacy",
        callId: "patch-directional-destination",
        fileChanges: {
          "src/source.ts": {
            type: "update",
            unified_diff: "@@ -1 +1 @@",
            move_path: `src/safe${unsafeFormatting}cod.exe`,
          },
        },
        grantRoot: "/workspace",
      })).toBeUndefined();
    }
  });

  it.skipIf(process.platform !== "win32")(
    "preserves exact Windows drive and UNC approval paths",
    () => {
      const paths = [
        String.raw`C:\workspace\link\..\target`,
        String.raw`\\server\share\project`,
        String.raw`C:\workspace\trailing-space `,
      ];
      const parsed = parseCodexApprovalRequest(
        "item/permissions/requestApproval",
        {
          permissions: {
            fileSystem: { read: paths },
          },
        },
      );

      expect(parsed?.requestedPermissions).toEqual({
        fileSystem: { read: paths },
      });
      expect(parsed?.request.permissionRoots).toEqual(
        paths.map((path) => ({ path, access: "read" })),
      );
    },
  );

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

  it("rejects user-input payloads that cannot be represented without truncation", () => {
    const question = (index: number, optionCount = 1) => ({
      id: `question-${index}`,
      question: `Prompt ${index}`,
      options: Array.from({ length: optionCount }, (_, optionIndex) => ({
        id: `option-${optionIndex}`,
        label: `Option ${optionIndex}`,
      })),
    });

    expect(parseCodexInputRequest("item/tool/requestUserInput", {
      questions: [question(1), question(2), question(3), question(4)],
    })).toBeUndefined();
    expect(parseCodexInputRequest("item/tool/requestUserInput", {
      questions: [question(1, 4)],
    })).toBeUndefined();
    expect(parseCodexInputRequest("item/tool/requestUserInput", {
      questions: [question(1), null],
    })).toBeUndefined();
    expect(parseCodexInputRequest("item/tool/requestUserInput", {
      questions: [question(1), { ...question(2), id: "question-1" }],
    })).toBeUndefined();
    expect(parseCodexInputRequest("item/tool/requestUserInput", {
      questions: [{
        ...question(1),
        question: "x".repeat(1_001),
      }],
    })).toBeUndefined();
    expect(parseCodexInputRequest("item/tool/requestUserInput", {
      questions: [{
        ...question(1),
        options: [
          { id: "same", label: "One" },
          { id: "same", label: "Two" },
        ],
      }],
    })).toBeUndefined();
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

  it("frames split UTF-8 JSONL by bytes", () => {
    const lines: string[] = [];
    const failure = vi.fn();
    const decoder = new JsonLineDecoder(24, (line) => lines.push(line), failure);
    const payload = Buffer.from('{"text":"héllo"}\n{"ok":true}\n', "utf8");
    decoder.push(payload.subarray(0, 11));
    decoder.push(payload.subarray(11));
    decoder.end();
    expect(lines).toEqual(['{"text":"héllo"}', '{"ok":true}']);
    expect(failure).not.toHaveBeenCalled();
  });

  it("accepts the former 1 MiB boundary and the exact new frame limit", () => {
    const former = vi.fn();
    const formerFailure = vi.fn();
    const formerDecoder = new JsonLineDecoder(
      CODEX_APP_SERVER_MAX_FRAME_BYTES,
      former,
      formerFailure,
    );
    formerDecoder.push(Buffer.from(`${"x".repeat(1024 * 1024 + 32)}\n`));
    expect(former).toHaveBeenCalledOnce();
    expect(formerFailure).not.toHaveBeenCalled();

    const exact = vi.fn();
    const exactFailure = vi.fn();
    const exactDecoder = new JsonLineDecoder(
      CODEX_APP_SERVER_MAX_FRAME_BYTES,
      exact,
      exactFailure,
    );
    exactDecoder.push(Buffer.alloc(CODEX_APP_SERVER_MAX_FRAME_BYTES, 0x78));
    exactDecoder.end();
    expect(exact).toHaveBeenCalledOnce();
    expect(exactFailure).not.toHaveBeenCalled();
  });

  it("rejects max plus one, aggregate overflow, malformed UTF-8, and counts multibyte input", () => {
    const tooLargeFailure = vi.fn();
    const tooLarge = new JsonLineDecoder(
      CODEX_APP_SERVER_MAX_FRAME_BYTES,
      vi.fn(),
      tooLargeFailure,
    );
    tooLarge.push(Buffer.alloc(CODEX_APP_SERVER_MAX_FRAME_BYTES + 1, 0x78));
    expect(tooLargeFailure).toHaveBeenCalledWith("line-overflow");

    const aggregateFailure = vi.fn();
    const aggregate = new JsonLineDecoder(32, vi.fn(), aggregateFailure, 10);
    aggregate.push(Buffer.from("1234\n"));
    aggregate.push(Buffer.from("56789\n"));
    aggregate.push(Buffer.from("x"));
    expect(aggregateFailure).toHaveBeenCalledWith("aggregate-overflow");

    const multibyteLines: string[] = [];
    const multibyteFailure = vi.fn();
    const multibyte = new JsonLineDecoder(
      4,
      (line) => multibyteLines.push(line),
      multibyteFailure,
    );
    multibyte.push(Buffer.from("éé\n", "utf8"));
    expect(multibyteLines).toEqual(["éé"]);
    expect(multibyteFailure).not.toHaveBeenCalled();

    const multibyteOverflow = vi.fn();
    new JsonLineDecoder(4, vi.fn(), multibyteOverflow)
      .push(Buffer.from("ééé\n", "utf8"));
    expect(multibyteOverflow).toHaveBeenCalledWith("line-overflow");

    const malformed = vi.fn();
    new JsonLineDecoder(8, vi.fn(), malformed)
      .push(Buffer.from([0xc3, 0x28, 0x0a]));
    expect(malformed).toHaveBeenCalledWith("malformed-utf8");
  });

  it("delivers complete frames before aggregate overflow in the same stream chunk", () => {
    const lines: string[] = [];
    const failure = vi.fn();
    const decoder = new JsonLineDecoder(
      16,
      (line) => lines.push(line),
      failure,
      10,
    );

    decoder.push(Buffer.from("one\ntwo\nthree\n"));

    expect(lines).toEqual(["one", "two"]);
    expect(failure).toHaveBeenCalledOnce();
    expect(failure).toHaveBeenCalledWith("aggregate-overflow");
  });
});
