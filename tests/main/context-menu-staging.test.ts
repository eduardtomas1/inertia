import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() }, Menu: { buildFromTemplate: vi.fn() } }));

import { contextMenuEntries } from "../../src/main/context-menu-ipc";
import { parseContextMenuRequest } from "../../src/shared/context-menu";

const projectId = "33333333-3333-4333-8333-333333333333";
const conversationId = "11111111-1111-4111-8111-111111111111";
const anchor = { x: 1, y: 2 };

function labels(request: unknown, role: "main" | "detached-chat" = "main"): string[] {
  const parsed = parseContextMenuRequest(request);
  if (!parsed) throw new Error("Expected a valid request.");
  return contextMenuEntries(parsed, "linux", { role }).map((entry) =>
    "separator" in entry ? "-" : "action" in entry ? `${entry.label}:${entry.action}` : entry.label);
}

describe("changed-file context menu staging", () => {
  it("offers Stage and Unstage only for the flags the Changes panel sent", () => {
    const base = { kind: "diff-file", projectId, conversationId, relativePath: "src/a.ts", anchor };
    expect(labels(base)).not.toContain("Stage:git-stage");
    expect(labels({ ...base, stageable: true }).slice(-2)).toEqual(["-", "Stage:git-stage"]);
    expect(labels({ ...base, unstageable: true }).slice(-2)).toEqual(["-", "Unstage:git-unstage"]);
    expect(labels({ ...base, stageable: true, unstageable: true }).slice(-3))
      .toEqual(["-", "Stage:git-stage", "Unstage:git-unstage"]);
  });

  it("offers index actions in a detached chat window too", () => {
    expect(labels({
      kind: "diff-file",
      projectId,
      conversationId,
      relativePath: "src/a.ts",
      stageable: true,
      unstageable: true,
      anchor,
    }, "detached-chat").join(" ")).toMatch(/Stage:git-stage Unstage:git-unstage/u);
  });

  it("validates staging flags at the IPC boundary", () => {
    const base = { kind: "diff-file", projectId, relativePath: "src/a.ts", anchor };
    expect(parseContextMenuRequest({ ...base, stageable: "yes" })).toBeNull();
    expect(parseContextMenuRequest({ ...base, unstageable: 1 })).toBeNull();
    expect(parseContextMenuRequest({ kind: "project-link", projectId, relativePath: "a", stageable: true, anchor }))
      .toBeNull();
    expect(parseContextMenuRequest({ ...base, stageable: false })).toEqual(base);
  });
});
