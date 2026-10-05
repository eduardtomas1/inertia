import { randomUUID } from "node:crypto";

import { acpPermissionDetail } from "./acp-permission-detail";
import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolKind,
} from "@agentclientprotocol/sdk";

import type {
  AgentHarnessStartOptions,
  createAgentHarnessEmitter,
} from "./agent-harness";
import { isSafeApprovalDisplayText } from "./approval-display";
import { acpAttachmentReadAllowed } from "./attachment-read-grant";
import type { AgentApprovalDecision } from "./interactions";

export const MAX_PENDING_CURSOR_INTERACTIONS = 64;
const MAX_APPROVAL_TEXT_CHARS = 1024 * 1024;

export interface PendingCursorApproval {
  resolve: (decision: AgentApprovalDecision) => void;
  settled: boolean;
}

type CursorRichEmitter = ReturnType<typeof createAgentHarnessEmitter>["rich"];

export function cursorPermissionDisplayIsSafe(
  params: Pick<RequestPermissionRequest, "toolCall">,
): boolean {
  return isSafeApprovalDisplayText(
    params.toolCall.title || "Cursor requested permission",
  ) && isSafeApprovalDisplayText(acpPermissionDetail(params, "Cursor requested permission."), true);
}

export function isCursorFileMutationKind(
  kind: ToolKind | null | undefined,
): boolean {
  return kind === "edit" || kind === "delete" || kind === "move";
}

export function cursorOneShotPermissionOption(
  options: PermissionOption[],
  allow: boolean,
): PermissionOption | undefined {
  // Inertia's provider-neutral approval only represents this request. Never
  // turn it into a provider-persisted grant or denial without an explicit UI
  // choice for that stronger scope.
  const kind = allow ? "allow_once" : "reject_once";
  return options.find((option) => option.kind === kind);
}

export async function cursorPermission(
  params: RequestPermissionRequest,
  displayParams: RequestPermissionRequest,
  signal: AbortSignal,
  options: AgentHarnessStartOptions,
  emit: CursorRichEmitter,
  approvals: Map<string, PendingCursorApproval>,
): Promise<RequestPermissionResponse> {
  const allow = cursorOneShotPermissionOption(params.options, true);
  if (allow && acpAttachmentReadAllowed(params, options.input.attachmentReadRoots)) {
    return { outcome: { outcome: "selected", optionId: allow.optionId } };
  }
  if (options.input.interactionMode === "plan") {
    return { outcome: { outcome: "cancelled" } };
  }
  const fileMutation = isCursorFileMutationKind(params.toolCall.kind);
  if (
    options.input.access === "full"
    || (options.input.access === "auto-edit" && fileMutation)
  ) {
    return allow ? { outcome: { outcome: "selected", optionId: allow.optionId } } : { outcome: { outcome: "cancelled" } };
  }
  return askCursorPermission(params, displayParams, signal, options, emit, approvals);
}

export async function askCursorPermission(
  params: RequestPermissionRequest,
  displayParams: RequestPermissionRequest,
  signal: AbortSignal,
  options: AgentHarnessStartOptions,
  emit: CursorRichEmitter,
  approvals: Map<string, PendingCursorApproval>,
): Promise<RequestPermissionResponse> {
  if (!cursorPermissionDisplayIsSafe(displayParams)) {
    return { outcome: { outcome: "cancelled" } };
  }
  const fileMutation = isCursorFileMutationKind(params.toolCall.kind);
  const requestId = randomUUID();
  const decision = await new Promise<AgentApprovalDecision>((resolve) => {
    if (approvals.size >= MAX_PENDING_CURSOR_INTERACTIONS) {
      throw new Error("Cursor exceeded the bounded approval budget.");
    }
    approvals.set(requestId, { resolve, settled: false });
    signal.addEventListener("abort", () => {
      const pending = approvals.get(requestId);
      if (!pending || pending.settled) return;
      pending.settled = true;
      approvals.delete(requestId);
      emit({ type: "approval-resolved", requestId, decision: "cancel" });
      resolve("cancel");
    }, { once: true });
    emit({
      type: "approval",
      request: {
        requestId,
        kind: params.toolCall.kind === "execute"
          ? "command"
          : fileMutation
            ? "file-change"
            : "permissions",
        title: (displayParams.toolCall.title || "Cursor requested permission")
          .slice(0, MAX_APPROVAL_TEXT_CHARS),
        detail: acpPermissionDetail(displayParams, "Cursor requested permission.")
          .slice(0, MAX_APPROVAL_TEXT_CHARS),
        cwd: options.input.cwd,
        permissionRoots: [],
        availableDecisions: ["approve", "deny", "cancel"],
      },
    });
  });
  if (decision === "cancel") return { outcome: { outcome: "cancelled" } };
  const selected = cursorOneShotPermissionOption(
    params.options,
    decision === "approve",
  );
  return selected ? { outcome: { outcome: "selected", optionId: selected.optionId } } : { outcome: { outcome: "cancelled" } };
}
