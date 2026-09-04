import { commandExecutionLabel } from "./app-server-config";
import { strictCodexProviderIdentifier } from "./app-server-subagents";
import { codexHookActivityPhase, codexItemActivityPhase } from "./app-server-status";
import { boundedText, objectValue, stringValue, type JsonObject } from "./protocol";
import { completedReasoningSummary } from "./reasoning";
import { providerActivityDetailSections } from "../provider/activity-detail";
import { stableProviderActivityId } from "../provider/activity-lifecycle";
import type { CodexAppServerOptions } from "./types";

export type CodexItemActivity = {
  kind: "command" | "tool" | "system";
  label: string;
};

export interface CodexItemProjectionState {
  deltaItems: Set<string>;
  reasoningDeltaItems: Set<string>;
  itemActivities: Map<string, CodexItemActivity>;
  completedPlanItemIds: Set<string>;
  maxTrackedActivities: number;
}

interface CodexItemProjectionHost {
  options: CodexAppServerOptions;
  appendResultText: (text: string) => void;
  setLastActivityId: (activityId: string) => void;
  handleSubagentItem: (
    item: JsonObject,
    phase: "started" | "completed",
    threadId: string | null,
  ) => boolean;
}

export function handleCodexHook(
  host: Pick<CodexItemProjectionHost, "options">,
  method: "hook/started" | "hook/completed",
  params: JsonObject,
): void {
  const run = objectValue(params.run);
  if (!run) return;
  const activityId = boundedText(run.id, 1_000);
  const eventName = boundedText(run.eventName, 120) ?? "lifecycle";
  const phase = codexHookActivityPhase(method, run.status);
  const entries = Array.isArray(run.entries)
    ? run.entries.slice(0, 100).flatMap((entry) =>
        boundedText(objectValue(entry)?.text, 4_000) ?? [])
    : [];
  const detail = [boundedText(run.statusMessage, 4_000), ...entries]
    .filter(Boolean)
    .join("\n");
  host.options.onActivity?.("tool", phase, `Hook · ${eventName}`, {
    ...(activityId ? { activityId } : {}),
    ...(detail ? { detail } : {}),
  });
}

export function handleCodexItem(
  host: CodexItemProjectionHost,
  state: CodexItemProjectionState,
  method: "item/started" | "item/completed",
  params: JsonObject,
): void {
  const item = objectValue(params.item);
  const activityId = boundedText(item?.id, 1_000);
  if (activityId) host.setLastActivityId(activityId);
  if (item && host.handleSubagentItem(
    item,
    method === "item/started" ? "started" : "completed",
    strictCodexProviderIdentifier(params.threadId),
  )) return;
  const itemType = stringValue(item?.type);
  if (!item) return;
  const phase = codexItemActivityPhase(method, item.status);
  if (itemType === "reasoning") {
    host.options.onActivity?.(
      "reasoning",
      phase,
      "Thinking",
      activityId ? { activityId } : undefined,
    );
    if (method === "item/completed") {
      let summary = completedReasoningSummary(item, state.reasoningDeltaItems);
      const itemId = boundedText(item.id, 512);
      if (
        !summary
        && (!itemId || !state.reasoningDeltaItems.has(itemId))
        && Array.isArray(item.summary)
      ) {
        summary = boundedText(
          item.summary.filter((part): part is string =>
            typeof part === "string").join("\n"),
          128_000,
        );
      }
      if (summary) host.options.onReasoning?.(summary);
      if (itemId) state.reasoningDeltaItems.delete(itemId);
    }
  } else if (itemType === "commandExecution") {
    const command = item.command ?? item.cmd;
    const output = item.aggregatedOutput ?? item.output
      ?? [item.stdout, item.stderr];
    const label = commandExecutionLabel(item);
    const detail = providerActivityDetailSections({
      command,
      ...(method === "item/completed" ? { output } : {}),
    });
    if (method === "item/started") {
      rememberItemActivity(state, activityId, { kind: "command", label });
    }
    emitItemActivity(host, "command", phase, label, activityId, detail);
    deleteCompletedActivity(state, method, activityId);
  } else if (itemType === "fileChange") {
    if (method === "item/started") {
      rememberItemActivity(state, activityId, {
        kind: "tool",
        label: "File change",
      });
    }
    emitItemActivity(
      host,
      "tool",
      phase,
      "File change",
      activityId,
      fileChangeDetail(item),
    );
    deleteCompletedActivity(state, method, activityId);
  } else if (itemType === "agentMessage" && method === "item/completed") {
    const itemId = boundedText(item.id, 512);
    const text = stringValue(item.text);
    if (text && (!itemId || !state.deltaItems.has(itemId))) {
      host.appendResultText(text);
      host.options.onText?.(text);
    }
    if (itemId) state.deltaItems.delete(itemId);
  } else if (itemType === "plan" && method === "item/completed") {
    const text = boundedText(item.text, 128_000);
    if (text) host.options.onPlan?.(text, []);
    if (
      activityId
      && state.completedPlanItemIds.size < state.maxTrackedActivities
    ) {
      state.completedPlanItemIds.add(activityId);
    }
    host.options.onActivity?.(
      "turn",
      phase,
      "Plan completed",
      activityId
        ? { activityId: stableProviderActivityId("codex-plan", activityId) }
        : undefined,
    );
  } else if (itemType === "mcpToolCall") {
    const server = boundedText(item.server, 120);
    const tool = boundedText(item.tool, 160);
    const label = server && tool
      ? `MCP · ${server}/${tool}`
      : tool ? `MCP · ${tool}` : "MCP tool";
    if (method === "item/started") {
      rememberItemActivity(state, activityId, { kind: "tool", label });
    }
    const result = objectValue(item.result);
    const error = objectValue(item.error);
    const detail = providerActivityDetailSections({
      output: result?.content,
      error: error?.message,
    });
    emitItemActivity(host, "tool", phase, label, activityId, detail);
    deleteCompletedActivity(state, method, activityId);
  } else if (itemType === "dynamicToolCall") {
    const tool = boundedText(item.tool, 160);
    const label = tool ? `Tool · ${tool}` : "Dynamic tool";
    if (method === "item/started") {
      rememberItemActivity(state, activityId, { kind: "tool", label });
    }
    const output = codexItemTextContent(item.contentItems);
    emitItemActivity(
      host,
      "tool",
      phase,
      label,
      activityId,
      output ? providerActivityDetailSections({ output }) ?? undefined : undefined,
    );
    deleteCompletedActivity(state, method, activityId);
  } else if (itemType === "webSearch") {
    const search = webSearchLabel(item);
    emitItemActivity(
      host,
      "tool",
      phase,
      search.label,
      activityId,
      search.detail,
    );
  } else if (itemType === "imageView") {
    const path = boundedText(item.path, 4_000);
    emitItemActivity(
      host,
      "tool",
      phase,
      "View image",
      activityId,
      path ? `Path:\n${path}` : undefined,
    );
  } else if (itemType === "imageGeneration") {
    emitItemActivity(host, "tool", phase, "Generate image", activityId);
  } else if (itemType === "contextCompaction") {
    emitItemActivity(host, "system", phase, "Context compaction", activityId);
  } else if (itemType === "enteredReviewMode") {
    host.options.onActivity?.("system", "info", "Entered review mode");
  } else if (itemType === "exitedReviewMode") {
    host.options.onActivity?.("system", "info", "Exited review mode");
  } else {
    deleteCompletedActivity(state, method, activityId);
  }
}

function rememberItemActivity(
  state: CodexItemProjectionState,
  activityId: string | null | undefined,
  activity: CodexItemActivity,
): void {
  if (!activityId || state.itemActivities.has(activityId)) return;
  if (state.itemActivities.size >= state.maxTrackedActivities) return;
  state.itemActivities.set(activityId, activity);
}

function deleteCompletedActivity(
  state: CodexItemProjectionState,
  method: "item/started" | "item/completed",
  activityId: string | null | undefined,
): void {
  if (method === "item/completed" && activityId) {
    state.itemActivities.delete(activityId);
  }
}

function emitItemActivity(
  host: Pick<CodexItemProjectionHost, "options">,
  kind: CodexItemActivity["kind"],
  phase: "started" | "completed" | "failed" | "info",
  label: string,
  activityId?: string | null,
  detail?: string | null,
): void {
  host.options.onActivity?.(kind, phase, label, {
    ...(activityId ? { activityId } : {}),
    ...(detail ? { detail } : {}),
  });
}

function codexItemTextContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = value.flatMap((entry) => {
    const content = objectValue(entry);
    if (
      (content?.type === "text" || content?.type === "inputText")
      && typeof content.text === "string"
    ) return content.text;
    return [];
  }).join("\n");
  return boundedText(text, 32_000);
}

function fileChangeDetail(item: JsonObject): string | undefined {
  if (!Array.isArray(item.changes)) return undefined;
  const changes = item.changes.slice(0, 100).flatMap((entry) => {
    const change = objectValue(entry);
    const path = boundedText(change?.path, 2_000);
    if (!path) return [];
    const kind = boundedText(change?.kind, 80);
    return `${kind ? `${kind}: ` : ""}${path}`;
  });
  return changes.length > 0 ? `Files:\n${changes.join("\n")}` : undefined;
}

function webSearchLabel(item: JsonObject): { label: string; detail?: string } {
  const action = objectValue(item.action);
  const actionType = stringValue(action?.type);
  if (actionType === "openPage") {
    const url = boundedText(action?.url, 4_000);
    return { label: "Open web page", ...(url ? { detail: `URL:\n${url}` } : {}) };
  }
  if (actionType === "findInPage") {
    const url = boundedText(action?.url, 4_000);
    const pattern = boundedText(action?.pattern, 1_000);
    const detail = [
      url ? `URL:\n${url}` : null,
      pattern ? `Pattern:\n${pattern}` : null,
    ].filter((part): part is string => Boolean(part)).join("\n\n");
    return { label: "Find on web page", ...(detail ? { detail } : {}) };
  }
  const query = boundedText(action?.query, 4_000)
    ?? boundedText(item.query, 4_000);
  return {
    label: "Search the web",
    ...(query ? { detail: `Query:\n${query}` } : {}),
  };
}
