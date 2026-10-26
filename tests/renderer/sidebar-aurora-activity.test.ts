import { describe, expect, it } from "vitest";

import { sidebarAuroraActivity } from "../../src/renderer/src/components/sidebar/sidebarAuroraActivity";
import type { SidebarThreadStatus, SidebarThreadView } from "../../src/renderer/src/utils/sidebarModel";

function view(status: SidebarThreadStatus, overrides: Partial<SidebarThreadView> & { archived?: boolean } = {}): SidebarThreadView {
  const { archived = false, ...rest } = overrides;
  return {
    conversation: { archivedAt: archived ? "2026-10-26T08:00:00.000Z" : null } as SidebarThreadView["conversation"],
    run: null,
    status,
    needsAttention: status === "approval" || status === "input" || status === "failed" || status === "limited",
    unread: false,
    hidden: false,
    settled: false,
    ...rest,
  };
}

describe("sidebar aurora activity", () => {
  it("rests when nothing runs or waits", () => {
    expect(sidebarAuroraActivity([])).toBe("idle");
    expect(sidebarAuroraActivity([view("completed"), view("idle"), view("limited")])).toBe("idle");
  });

  it("works while any chat runs", () => {
    expect(sidebarAuroraActivity([view("completed"), view("working")])).toBe("working");
  });

  it("lets a waiting approval, answer or failure win over running work", () => {
    for (const status of ["approval", "input", "failed"] as const) {
      expect(sidebarAuroraActivity([view("working"), view(status)])).toBe("attention");
    }
  });

  it("ignores archived, hidden, settled and acknowledged chats", () => {
    expect(sidebarAuroraActivity([
      view("approval", { archived: true }),
      view("input", { hidden: true }),
      view("failed", { settled: true }),
      view("failed", { needsAttention: false }),
      view("working", { archived: true }),
    ])).toBe("idle");
  });
});
