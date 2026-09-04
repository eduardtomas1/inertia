import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type {
  AgentTurn,
  SubagentTrace,
} from "../../src/shared/contracts";
import { compactSubagentDisclosureRows } from "../../src/renderer/src/utils/subagentCompactRows";
import {
  canFollowUpSubagentTrace,
  canStopSubagentTrace,
  subagentDisclosureRows,
  subagentDisclosureSummary,
  subagentDisclosureStats,
  subagentRelationshipLabel,
  subagentRouteLabel,
  subagentStatusLabel,
  subagentTraceSummary,
} from "../../src/renderer/src/utils/subagentDisclosure";

const styles = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);

function trace(
  update: Partial<SubagentTrace> = {},
): SubagentTrace {
  const status = update.status ?? "running";
  return {
    id: "trace-parent",
    conversationId: "conversation-1",
    runId: "run-1",
    turnId: "turn-1",
    providerId: "claude",
    providerTaskId: "task-parent",
    providerAgentId: "agent-parent",
    parentTraceId: null,
    parentProviderAgentId: null,
    parentProviderToolUseId: null,
    providerToolUseId: "tool-parent",
    providerRole: "researcher",
    providerName: "Evidence",
    providerStatus: null,
    status,
    isLive: update.isLive ?? [
      "queued", "spawned", "running", "waiting",
    ].includes(status),
    description: "Inspect",
    progress: null,
    result: null,
    sequence: 1,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    ...update,
  };
}

function turn(
  update: Partial<AgentTurn> = {},
): AgentTurn {
  return {
    id: "turn-1",
    conversationId: "conversation-1",
    runId: "run-1",
    userMessageId: "message-1",
    terminalAssistantMessageId: null,
    providerId: "claude",
    modelSelection: {
      harnessId: "claude-agent-sdk",
      backendProfileId: "builtin:claude",
      backendProfileDisplayName: "Claude",
      backendConfigurationRevision: 0,
      modelId: "sonnet",
      alias: null,
      reasoningEffort: null,
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
    },
    continuationIdentity: {
      harnessId: "claude-agent-sdk",
      backendProfileId: "builtin:claude",
      backendConfigurationRevision: 0,
      endpointIdentity: "native:claude",
      modelIdentity: null,
    },
    harnessId: "claude-agent-sdk",
    backendProfileId: "builtin:claude",
    model: "sonnet",
    modelAlias: null,
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: null,
    providerSessionAfter: null,
    requestedAt: "2030-01-01T00:00:00.000Z",
    startedAt: "2030-01-01T00:00:00.000Z",
    completedAt: null,
    status: "running",
    terminalReason: null,
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 0,
    association: "authoritative",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    ...update,
  };
}

describe("inline delegated-agent disclosure", () => {
  it("preserves parent-child order and bounds malformed nesting", () => {
    const parent = trace();
    const child = trace({
      id: "trace-child",
      providerTaskId: "task-child",
      providerAgentId: "agent-child",
      parentTraceId: parent.id,
      parentProviderAgentId: parent.providerAgentId,
      providerToolUseId: "tool-child",
      sequence: 2,
    });
    expect(subagentDisclosureRows([parent, child], [turn()])).toMatchObject([
      { trace: { id: "trace-parent" }, depth: 0, canStop: true },
      { trace: { id: "trace-child" }, depth: 1, canStop: true },
    ]);
    expect(subagentDisclosureSummary([parent, child])).toBe(
      "2 delegated tasks · 2 working",
    );
  });

  it("derives Stop only from the current persisted Claude SDK route", () => {
    const live = trace();
    expect(canStopSubagentTrace(live, [turn()])).toBe(true);
    expect(canStopSubagentTrace(live, [
      turn({ harnessId: "claude-cli" }),
    ])).toBe(false);
    expect(canStopSubagentTrace(
      trace({ providerTaskId: null }),
      [turn()],
    )).toBe(false);
    expect(canStopSubagentTrace(
      trace({ status: "completed", isLive: false }),
      [turn()],
    )).toBe(false);
    expect(canStopSubagentTrace(live, [
      turn({
        status: "completed",
        completedAt: "2030-01-01T00:01:00.000Z",
      }),
    ])).toBe(false);
  });

  it("derives parent guidance and route identity from the persisted owner turn", () => {
    const claude = trace();
    expect(canFollowUpSubagentTrace(claude, [turn()])).toBe(true);
    expect(subagentRouteLabel(claude, [turn()])).toBe("Claude · Agent SDK");
    expect(canFollowUpSubagentTrace(claude, [turn({
      status: "completed",
      completedAt: "2030-01-01T00:01:00.000Z",
    })])).toBe(false);

    const codex = trace({ providerId: "codex" });
    const codexTurn = turn({
      providerId: "codex",
      harnessId: "codex-app-server",
    });
    expect(canFollowUpSubagentTrace(codex, [codexTurn])).toBe(true);
    expect(canStopSubagentTrace(codex, [codexTurn])).toBe(false);
    expect(subagentRouteLabel(codex, [codexTurn])).toBe("Codex · App Server");
    expect(subagentRouteLabel(codex, [])).toBe(
      "Codex · historical harness unavailable",
    );

    const gemini = trace({ providerId: "gemini" });
    const geminiTurn = turn({
      providerId: "gemini",
      harnessId: "gemini-acp",
    });
    expect(subagentRouteLabel(gemini, [geminiTurn])).toBe("Gemini · ACP");
    expect(canFollowUpSubagentTrace(gemini, [geminiTurn])).toBe(false);
    expect(canStopSubagentTrace(gemini, [geminiTurn])).toBe(false);
  });

  it("keeps future provider states visibly unknown instead of relabeling them", () => {
    expect(subagentStatusLabel(trace({
      providerId: "codex",
      providerStatus: "futureState",
      status: "unknown",
      isLive: true,
    }))).toBe("Unknown (futureState)");
    expect(subagentStatusLabel(trace({
      providerId: "claude",
      providerStatus: "killed",
      status: "cancelled",
      isLive: false,
    }))).toBe("Cancelled");
    expect(subagentStatusLabel(trace({
      providerId: "claude",
      providerStatus: "in_progress",
      status: "running",
      isLive: true,
    }))).toBe("Running");
    expect(subagentStatusLabel(trace({
      providerId: "claude",
      providerStatus: "running",
      status: "cancelled",
      isLive: false,
    }))).toBe("Cancelled");
    expect(canStopSubagentTrace(
      trace({ providerStatus: "pending", status: "queued" }),
      [turn()],
    )).toBe(true);
    expect(canStopSubagentTrace(
      trace({
        providerStatus: "futureState",
        status: "unknown",
        isLive: true,
      }),
      [turn()],
    )).toBe(true);
    expect(subagentDisclosureSummary([
      trace({
        providerStatus: "futureState",
        status: "unknown",
        isLive: true,
      }),
    ])).toBe("1 delegated task · 1 working");
  });

  it("summarizes outcomes and keeps every urgent branch in a bounded roster", () => {
    const traces = [
      trace({ id: "done", status: "completed", isLive: false, sequence: 1 }),
      trace({ id: "failed", status: "failed", isLive: false, sequence: 2 }),
      trace({ id: "lost", status: "lost", isLive: false, sequence: 3 }),
      trace({ id: "stopped", status: "cancelled", isLive: false, sequence: 4 }),
      trace({ id: "live-a", sequence: 5 }),
      trace({ id: "live-b", sequence: 6 }),
      trace({ id: "older", status: "completed", isLive: false, sequence: 0 }),
    ];
    const rows = subagentDisclosureRows(traces, [turn()]);
    const compact = compactSubagentDisclosureRows(rows, 4);

    expect(compact.map(({ trace: item }) => item.id)).toEqual([
      "failed",
      "lost",
      "live-a",
      "live-b",
    ]);
    expect(subagentDisclosureStats(traces)).toEqual({
      total: 7,
      active: 2,
      completed: 2,
      stopped: 1,
      needsReview: 2,
    });
    expect(subagentDisclosureSummary(traces)).toBe(
      "7 delegated tasks · 2 working · 2 needs review · 3 settled",
    );
  });

  it("deduplicates urgent branch endpoints through settled intermediaries", () => {
    const lineage = Array.from({ length: 11 }, (_, index) => trace({
      id: `lineage-${index}`,
      parentTraceId: index === 0 ? null : `lineage-${index - 1}`,
      providerStatus: index % 2 === 0 ? "running" : "completed",
      status: index % 2 === 0 ? "running" : "completed",
      isLive: index % 2 === 0,
      sequence: index + 2,
    }));
    const failedSibling = trace({
      id: "failed-sibling",
      providerStatus: "failed",
      status: "failed",
      isLive: false,
      sequence: 1,
    });
    const compact = compactSubagentDisclosureRows(
      subagentDisclosureRows([failedSibling, ...lineage], [turn()]),
      6,
    );

    expect(compact.map(({ trace: item }) => item.id)).toContain(
      "failed-sibling",
    );
    expect(compact.map(({ trace: item }) => item.id)).toContain("lineage-10");
  });

  it("does not mislabel an unresolved nested provider parent as the host turn", () => {
    const orphan = trace({
      parentTraceId: null,
      parentProviderAgentId: "provider-parent-that-aged-out",
    });
    expect(subagentRelationshipLabel(orphan, [orphan])).toBe(
      "Nested delegated task · parent unavailable",
    );
    expect(subagentRelationshipLabel(trace(), [trace()])).toBe(
      "Delegated by parent agent",
    );
  });

  it("bounds collapsed recent activity while leaving the persisted detail intact", () => {
    const result = "provider detail ".repeat(2_000);
    const completed = trace({ status: "completed", isLive: false, result });
    expect(subagentTraceSummary(completed)).toHaveLength(280);
    expect(subagentTraceSummary(completed)).toMatch(/…$/u);
    expect(completed.result).toBe(result);
  });

  it("keeps one intentional danger hover and adjacent focus treatment for Stop", () => {
    const hoverRules = [...styles.matchAll(
      /\.subagent-stop-button:hover:not\(:disabled\)\s*\{(?<body>[^}]*)\}/gu,
    )];
    const focusRules = [...styles.matchAll(
      /\.subagent-row-actions button:focus-visible\s*\{(?<body>[^}]*)\}/gu,
    )];
    expect(hoverRules).toHaveLength(1);
    expect(hoverRules[0]?.groups?.body).toContain("color: var(--danger)");
    expect(hoverRules[0]?.groups?.body).toContain("var(--danger-soft)");
    expect(focusRules).toHaveLength(1);
    expect(focusRules[0]?.groups?.body).toContain("var(--focus-ring)");

    const componentRule = styles.indexOf(".subagent-row-actions button {");
    const hoverRule = styles.indexOf(
      ".subagent-stop-button:hover:not(:disabled) {",
    );
    const focusRule = styles.indexOf(
      ".subagent-row-actions button:focus-visible {",
    );
    const usagePopover = styles.indexOf(".usage-popover {");
    expect(componentRule).toBeLessThan(focusRule);
    expect(focusRule).toBeLessThan(hoverRule);
    expect(focusRule).toBeLessThan(usagePopover);
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.subagent-details-button svg,[\s\S]*?transition: none;/u,
    );
  });
});
