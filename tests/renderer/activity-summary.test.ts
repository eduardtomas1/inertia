import { describe, expect, it } from "vitest";

import {
  ACTIVITY_GROUP_LIVE_WINDOW,
  activityAttentionSeverity,
  activityCommandLine,
  activitySummaryLabel,
  activitySummaryParts,
  activityWorkKind,
  commandDisplayText,
  resolveActivityGroupWindow,
  summarizeActivities,
} from "../../src/renderer/src/utils/responseTimeline";
import type { AgentActivity } from "../../src/shared/contracts";

function activity(
  id: string,
  overrides: Partial<AgentActivity> = {},
): AgentActivity {
  return {
    id,
    conversationId: "conversation-1",
    runId: "run-1",
    turnId: "turn-1",
    kind: "command",
    title: "Command",
    detail: null,
    status: "completed",
    createdAt: "2026-09-17T08:00:00.000Z",
    ...overrides,
  };
}

function command(id: string, text: string, overrides: Partial<AgentActivity> = {}): AgentActivity {
  return activity(id, { detail: `Command:\n${text}`, ...overrides });
}

describe("activity group summaries", () => {
  it("unwraps provider shell wrappers into the first meaningful command line", () => {
    expect(commandDisplayText("/bin/bash -lc 'cd /workspace && rg -n \"alias\" src'"))
      .toBe("rg -n \"alias\" src");
    expect(commandDisplayText("/bin/bash -lc \"python3 -B - <<'PY'\nfrom pathlib import Path\nPY\""))
      .toBe("python3 -B - <<'PY'");
    expect(commandDisplayText("bash -c 'echo '\"'\"'quoted'\"'\"''"))
      .toBe("echo 'quoted'");
    expect(commandDisplayText("npm test")).toBe("npm test");
    expect(commandDisplayText("/bin/bash -lc 'export JAVA_HOME=/usr/lib/jvm/java-17\nexport PATH=\"$JAVA_HOME/bin:$PATH\"\nset -e\ncd build\nant -f src/build.xml compile'"))
      .toBe("ant -f src/build.xml compile");
    expect(commandDisplayText("export ONLY=1")).toBe("export ONLY=1");
  });

  it("classifies reads, searches, edits, commands, and generic tools across providers", () => {
    expect(activityWorkKind(command("cat", "/bin/bash -lc 'cat src/build.xml'"))).toBe("read");
    expect(activityWorkKind(command("sed", "/bin/bash -lc \"sed -n '1,80p' src/app.ts\""))).toBe("read");
    expect(activityWorkKind(command("sed-edit", "sed -i -n 's/a/b/' src/app.ts"))).toBe("command");
    expect(activityWorkKind(command("rg", "/bin/bash -lc 'rg -n \"google\" lib/'"))).toBe("search");
    expect(activityWorkKind(command("ls", "ls lib/shared"))).toBe("search");
    expect(activityWorkKind(command("git-grep", "git grep TODO"))).toBe("search");
    expect(activityWorkKind(command("env", "CI=1 FORCE_COLOR=0 grep -r x ."))).toBe("search");
    expect(activityWorkKind(command("ant", "/bin/bash -lc 'export JAVA_HOME=/usr/lib/jvm\nant compile'"))).toBe("command");
    expect(activityWorkKind(activity("claude-bash", { title: "Bash", detail: "Output:\nok" }))).toBe("command");
    expect(activityWorkKind(activity("npm", { title: "npm run test" }))).toBe("command");
    expect(activityWorkKind(activity("read", { kind: "tool", title: "Read" }))).toBe("read");
    expect(activityWorkKind(activity("grep", { kind: "tool", title: "Grep" }))).toBe("search");
    expect(activityWorkKind(activity("glob", { kind: "tool", title: "Glob" }))).toBe("search");
    expect(activityWorkKind(activity("web", { kind: "tool", title: "WebSearch" }))).toBe("search");
    expect(activityWorkKind(activity("edit", { kind: "tool", title: "MultiEdit" }))).toBe("edit");
    expect(activityWorkKind(activity("patch", { kind: "tool", title: "File change" }))).toBe("edit");
    expect(activityWorkKind(activity("file", { kind: "file", title: "src/app.ts" }))).toBe("edit");
    expect(activityWorkKind(activity("mcp", { kind: "tool", title: "MCP · github/search_issues" }))).toBe("tool");
    expect(activityWorkKind(activity("status", { kind: "status", title: "Warning: fallback used" }))).toBe("event");
    expect(activityWorkKind(activity("error", { kind: "error", title: "Provider could not continue" }))).toBe("event");
  });

  it("names generic command rows by what they ran instead of the provider label", () => {
    expect(activityCommandLine(command("run", "/bin/bash -lc 'ant compile'", { status: "running" })))
      .toEqual({ verb: "Running", target: "ant compile" });
    expect(activityCommandLine(command("read", "/bin/bash -lc 'cat AGENTS.md'")))
      .toEqual({ verb: "Read", target: "cat AGENTS.md" });
    expect(activityCommandLine(command("search", "rg foo", { status: "failed" })))
      .toEqual({ verb: "Searched", target: "rg foo" });
    expect(activityCommandLine(activity("named", { title: "npm run test", detail: "Command:\nnpm run test" })))
      .toBeNull();
    expect(activityCommandLine(activity("no-detail"))).toBeNull();
  });

  it("counts work and attention in the words the folded line shows", () => {
    const summary = summarizeActivities([
      command("a", "cat a"),
      command("b", "cat b"),
      command("c", "rg c"),
      command("d", "ant compile", { status: "failed" }),
      command("e", "ant compile"),
      command("f", "npm test", { status: "running" }),
      activity("g", { kind: "tool", title: "Edit" }),
      activity("h", { kind: "status", title: "Warning: fallback used" }),
      activity("i", { kind: "tool", title: "MCP · github/search_issues" }),
      activity("j", { kind: "error", title: "Provider could not continue", status: "failed" }),
    ]);

    expect(summary).toEqual({
      command: 3,
      read: 2,
      search: 1,
      edit: 1,
      tool: 1,
      failed: 2,
      warnings: 1,
      running: 1,
      events: 2,
    });
    const parts = activitySummaryParts(summary);
    expect(parts.map(({ count, label, tone }) => [count, label, tone])).toEqual([
      [3, "commands", "neutral"],
      [2, "files read", "neutral"],
      [1, "search", "neutral"],
      [1, "edit", "neutral"],
      [1, "tool call", "neutral"],
      [2, "failed", "failure"],
      [1, "warning", "warning"],
    ]);
    expect(activitySummaryLabel(parts)).toBe(
      "3 commands, 2 files read, 1 search, 1 edit, 1 tool call, 2 failed, 1 warning",
    );
    expect(activitySummaryLabel(activitySummaryParts(summarizeActivities([
      command("failed-build", "ant compile", { status: "failed" }),
      activity("provider-warning", { kind: "status", title: "Warning: fallback used" }),
    ])))).toBe("1 command, 1 failed, 1 warning");
    expect(activitySummaryLabel(activitySummaryParts(summarizeActivities([
      activity("status-one", { kind: "status", title: "Connected" }),
      activity("status-two", { kind: "status", title: "Reconnected" }),
    ])))).toBe("2 updates");
  });

  it("keeps a bounded live window, folds settled groups, and reveals only the latest failure on request", () => {
    const activities = Array.from({ length: 8 }, (_, index) =>
      command(`row-${index}`, "cat file", index === 2 || index === 5 ? { status: "failed" } : {}));
    const ids = (rows: ReturnType<typeof resolveActivityGroupWindow>) =>
      rows.map(({ activity: row, folded }) => `${row.id}:${folded ? "folded" : "open"}`);

    expect(ACTIVITY_GROUP_LIVE_WINDOW).toBe(4);
    expect(ids(resolveActivityGroupWindow(activities, { expanded: false, settled: false }))).toEqual([
      "row-3:folded",
      "row-4:open",
      "row-5:open",
      "row-6:open",
      "row-7:open",
    ]);
    expect(ids(resolveActivityGroupWindow(activities, { expanded: false, settled: true }))).toEqual([
      "row-3:folded",
      "row-4:folded",
      "row-5:folded",
      "row-6:folded",
      "row-7:folded",
    ]);
    expect(ids(resolveActivityGroupWindow(activities, {
      expanded: false,
      settled: true,
      revealLatestFailure: true,
    }))).toContain("row-5:open");
    expect(resolveActivityGroupWindow(activities, { expanded: true, settled: true }))
      .toHaveLength(8);
    expect(resolveActivityGroupWindow(activities, { expanded: true, settled: true })
      .every(({ folded }) => !folded)).toBe(true);
  });

  it("does not treat words inside command text or output as warnings", () => {
    expect(activityAttentionSeverity(command("rg-warning", "rg -n warning src"))).toBeNull();
    expect(activityAttentionSeverity(activity("output-skipped", {
      detail: "Command:\npython3 verify.py\n\nOutput:\n3 JARs skipped",
    }))).toBeNull();
    expect(activityAttentionSeverity(activity("error-skipped", {
      detail: "Command:\npython3 verify.py\n\nError:\nupload blocked by policy",
    }))).toBe("warning");
    expect(activityAttentionSeverity(activity("status-detail", {
      kind: "status",
      title: "Fallback activated",
      detail: "An unsupported optional capability was skipped.",
    }))).toBe("warning");
  });
});
