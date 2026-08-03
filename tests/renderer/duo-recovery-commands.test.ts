import { describe, expect, it } from "vitest";

import {
  formatDuoRecoveryCommand,
  recoveryCommandShell,
} from "../../src/renderer/src/utils/duoRecoveryCommands";

describe("Duo manual recovery commands", () => {
  it("quotes POSIX metacharacters and single quotes without a shell-evaluation gap", () => {
    const action = {
      label: "Remove retained linked worktree",
      cwd: "/tmp/project $()'quoted",
      executable: "git" as const,
      args: ["worktree", "remove", "--", "/tmp/tree `name`'quoted"],
    };
    expect(recoveryCommandShell(action, "Linux")).toBe("posix");
    expect(formatDuoRecoveryCommand(action, "posix")).toBe(
      "git -C '/tmp/project $()'\"'\"'quoted' 'worktree' 'remove' '--' '/tmp/tree `name`'\"'\"'quoted'",
    );
  });

  it("quotes PowerShell metacharacters, newlines, and single quotes", () => {
    const action = {
      label: "Remove retained linked worktree",
      cwd: "C:\\Users\\Ada $()\\project'name",
      executable: "git" as const,
      args: ["worktree", "remove", "--", "C:\\tree`name'\nnext"],
    };
    expect(recoveryCommandShell(action, "Linux")).toBe("powershell");
    expect(formatDuoRecoveryCommand(action, "powershell")).toBe(
      "git -C 'C:\\Users\\Ada $()\\project''name' 'worktree' 'remove' '--' 'C:\\tree`name''\nnext'",
    );
  });
});
