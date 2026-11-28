import type { ServerEvent } from "../../src/shared/contracts";
import {
  conversationDelegationSchema,
  type ConversationDelegation,
  type DelegatedTaskSummary,
} from "../../src/shared/orchestration-delegation";

export const PARENT_ID = "10101010-1010-4010-8010-101010101010";
export const SOURCE_TURN_ID = "20202020-2020-4020-8020-202020202020";

export function taskId(index: number): string {
  return index.toString(16).padStart(64, "a");
}

export function childId(index: number): string {
  return `3030303${index}-3030-4030-8030-303030303030`;
}

export function summary(index: number, overrides: Partial<DelegatedTaskSummary> = {}): DelegatedTaskSummary {
  return {
    taskId: taskId(index),
    kind: "original",
    childConversationId: childId(index),
    childTitle: `Child chat ${index}`,
    title: `Task ${index}`,
    role: "implementation",
    route: { providerId: "codex", harnessId: "codex-app-server", modelId: "gpt-test", reasoningEffort: "high" },
    sourceTurnId: SOURCE_TURN_ID,
    status: "running",
    workState: "working",
    completionWake: "always",
    wakeArmed: true,
    delivery: { state: null, generation: null },
    resultTurnId: null,
    resultPreview: null,
    createdAt: `2026-10-31T10:0${index}:00.000Z`,
    updatedAt: `2026-10-31T10:0${index}:00.000Z`,
    ...overrides,
  };
}

export function finished(index: number, overrides: Partial<DelegatedTaskSummary> = {}): DelegatedTaskSummary {
  return summary(index, {
    status: "completed",
    workState: "result_available",
    resultTurnId: `4040404${index}-4040-4040-8040-404040404040`,
    resultPreview: `Preview ${index}`,
    delivery: { state: "pending", generation: 1 },
    ...overrides,
  });
}

export function parentDelegation(tasks: DelegatedTaskSummary[], mailbox: NonNullable<ConversationDelegation["asParent"]>["mailbox"] = null): ConversationDelegation {
  return conversationDelegationSchema.parse({ asParent: { tasks, totalTasks: tasks.length, mailbox }, asChild: null });
}

export function resultEvent(result: unknown): ServerEvent {
  return { type: "request.result", requestId: "request", result } as ServerEvent;
}
