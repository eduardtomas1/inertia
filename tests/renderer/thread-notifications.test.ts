import { describe, expect, it } from "vitest";

import { threadNotificationKind } from "../../src/renderer/src/hooks/useThreadNotifications";
import type { Conversation } from "../../src/shared/contracts";
import { parseDesktopNotificationRequest } from "../../src/shared/desktop";
import { nativeModelSelection } from "../../src/shared/model-routing";

function conversation(
  status: Conversation["status"],
  overrides: Partial<Conversation> = {},
): Conversation {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    title: "Thread",
    providerId: "codex",
    modelSelection: nativeModelSelection({ providerId: "codex" }),
    continuationIdentity: null,
    model: "",
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    status,
    attentionKind: null,
    branch: null,
    worktreePath: null,
    providerSessionId: null,
    archivedAt: null,
    settledAt: null,
    completedAt: null,
    lastViewedAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    createdAt: "2026-08-09T09:00:00.000Z",
    updatedAt: "2026-08-09T09:00:00.000Z",
    ...overrides,
  };
}

describe("thread notifications", () => {
  it("maps only meaningful status transitions to native notification kinds", () => {
    const idle = conversation("idle");
    expect(threadNotificationKind(idle, conversation("needs-input", {
      attentionKind: "approval",
    }))).toBe("approval");
    expect(threadNotificationKind(idle, conversation("needs-input", {
      attentionKind: "input",
    }))).toBe("input");
    expect(threadNotificationKind(idle, conversation("failed"))).toBe("failed");
    expect(threadNotificationKind(idle, conversation("completed", {
      completedAt: "2026-08-09T09:01:00.000Z",
    }))).toBe("completed");
    expect(threadNotificationKind(idle, conversation("running"))).toBeNull();
  });

  it("accepts only the privacy-safe, exact IPC request shape", () => {
    const valid = {
      conversationId: "11111111-1111-4111-8111-111111111111",
      kind: "completed",
    };
    expect(parseDesktopNotificationRequest(valid)).toEqual(valid);
    expect(parseDesktopNotificationRequest({ ...valid, title: "secret prompt" }))
      .toBeNull();
    expect(parseDesktopNotificationRequest({ ...valid, conversationId: "thread" }))
      .toBeNull();
    expect(parseDesktopNotificationRequest({ ...valid, kind: "arbitrary" }))
      .toBeNull();
  });
});
