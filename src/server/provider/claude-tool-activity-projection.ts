import { providerActivityDetailSections } from "./activity-detail";
import type { AgentHarnessEmitter } from "./agent-harness";
import {
  boundedClaudeEventText as bounded,
  boundedClaudeIdentifier as boundedIdentifier,
  boundedClaudeLabel as boundedLabel,
  BoundedStringSet,
  claudeDetailLines as detailLines,
  claudeObjectValue as objectValue,
  claudePlanSteps as planSteps,
  MAX_CLAUDE_TRACKED_MESSAGE_IDS as MAX_TRACKED_MESSAGE_IDS,
} from "./claude-message-projector-support";

interface ClaudeToolActivity {
  kind: "command" | "tool";
  label: string;
  command?: string;
}

export class ClaudeToolActivityProjection {
  private readonly completed = new BoundedStringSet(MAX_TRACKED_MESSAGE_IDS);
  private readonly projectedPlans = new BoundedStringSet(MAX_TRACKED_MESSAGE_IDS);
  private readonly activities = new Map<string, ClaudeToolActivity>();

  constructor(private readonly emitter: AgentHarnessEmitter) {}

  isCompleted(activityId: string): boolean {
    return this.completed.has(activityId);
  }

  get(activityId: string): ClaudeToolActivity | undefined {
    return this.activities.get(activityId);
  }

  remember(activityId: string, activity: ClaudeToolActivity): void {
    this.activities.set(activityId, activity);
    if (this.activities.size <= MAX_TRACKED_MESSAGE_IDS) return;
    const oldest = this.activities.keys().next().value;
    if (typeof oldest === "string") this.activities.delete(oldest);
  }

  start(item: Record<string, unknown>): void {
    const activityId = boundedIdentifier(item.id);
    const name = boundedLabel(item.name, "Tool");
    const input = objectValue(item.input);
    if (
      name === "ExitPlanMode"
      && (!activityId || !this.projectedPlans.has(activityId))
    ) {
      const plan = typeof input?.plan === "string"
        ? input.plan
        : typeof input?.content === "string"
          ? input.content
          : undefined;
      if (plan) {
        this.emitter.rich({
          type: "plan",
          explanation: bounded(plan),
          steps: planSteps(plan),
        });
        if (activityId) this.projectedPlans.add(activityId);
      }
    }
    if (activityId && this.completed.has(activityId)) return;
    const command = name === "Bash" && typeof input?.command === "string" && input.command
      ? input.command
      : undefined;
    const existing = activityId ? this.activities.get(activityId) : undefined;
    if (existing && (!command || existing.command === command)) return;
    const kind = existing?.kind ?? (name === "Bash" ? "command" : "tool");
    const label = existing?.label ?? name;
    if (activityId) this.remember(activityId, { kind, label, ...(command ? { command } : {}) });
    this.emitter.activity(kind, "started", label, {
      ...(activityId ? { activityId } : {}),
      ...(name === "Bash"
        ? {
            detail: providerActivityDetailSections({
              command: input?.command,
            }) ?? undefined,
          }
        : {}),
    });
  }

  result(result: Record<string, unknown>): void {
    const activityId = boundedIdentifier(result.tool_use_id);
    if (!activityId || this.completed.has(activityId)) return;
    const activity = this.activities.get(activityId);
    // Replayed history and malformed out-of-order results must not create
    // ghost transcript activities without a matching provider tool call.
    if (!activity) return;
    const failed = result.is_error === true;
    const detail = providerActivityDetailSections({
      [failed ? "error" : "output"]: result.content,
    });
    this.emitter.activity(
      activity.kind,
      failed ? "failed" : "completed",
      activity.label,
      {
        activityId,
        ...(detail ? { detail } : {}),
      },
    );
    this.settle(activityId);
  }

  assistantResult(result: Record<string, unknown>): void {
    const activityId = boundedIdentifier(
      result.tool_use_id ?? result.server_tool_use_id,
    );
    if (!activityId || this.completed.has(activityId)) return;
    const activity = this.activities.get(activityId);
    if (!activity) return;
    const failed = result.is_error === true;
    this.emitter.activity(
      activity.kind,
      failed ? "failed" : "completed",
      activity.label,
      {
        activityId,
        detail: providerActivityDetailSections({
          [failed ? "error" : "output"]: result.content,
        }) ?? undefined,
      },
    );
    this.settle(activityId);
  }

  denial(message: {
    tool_use_id: string;
    message: string;
    decision_reason?: string;
    decision_reason_type?: string;
  }): void {
    const activityId = boundedIdentifier(message.tool_use_id);
    if (!activityId || this.completed.has(activityId)) return;
    const activity = this.activities.get(activityId);
    if (!activity) return;
    this.emitter.activity(
      activity.kind,
      "failed",
      activity.label,
      {
        activityId,
        detail: providerActivityDetailSections({
          error: detailLines([
            message.decision_reason,
            message.decision_reason_type
              ? `Decision: ${message.decision_reason_type}`
              : null,
            message.message,
          ]),
        }) ?? undefined,
      },
    );
    this.settle(activityId);
  }

  reset(): void {
    this.completed.clear();
    this.projectedPlans.clear();
    this.activities.clear();
  }

  private settle(activityId: string): void {
    this.activities.delete(activityId);
    this.completed.add(activityId);
  }
}
