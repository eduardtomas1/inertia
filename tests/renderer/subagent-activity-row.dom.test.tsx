import { readFileSync } from "node:fs";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { AgentActivity, SubagentTrace } from "../../src/shared/contracts";
import { ActivityGroup } from "../../src/renderer/src/components/response-timeline/activity";
import {
  SubagentActivityRow,
  UnlinkedSubagentRows,
} from "../../src/renderer/src/components/response-timeline/SubagentActivityRow";
import { TurnSubagentActivities } from "../../src/renderer/src/components/response-timeline/layers";
import {
  linkedSubagentTraces,
  unlinkedSubagentTraces,
} from "../../src/renderer/src/utils/subagentTaskPresentation";
import { taskTrace } from "./background-task-fixtures";

function activity(update: Partial<AgentActivity> = {}): AgentActivity {
  return {
    id: "activity-agent",
    conversationId: "conversation-1",
    runId: "run-1",
    turnId: "turn-1",
    kind: "tool",
    title: "Agent",
    detail: null,
    status: "completed",
    createdAt: "2030-01-01T00:00:00.000Z",
    ...update,
  };
}

const agent = taskTrace({
  id: "trace-agent",
  activityId: "activity-agent",
  providerRole: "general-purpose",
  providerName: null,
  description: "Survey the repository layout",
  model: "claude-haiku-4-5",
  modelSource: "observed",
  steps: [
    { label: "Read · src/index.ts", status: "completed" },
    { label: "Grep · TODO", status: "failed" },
    { label: "Bash · npm test", status: "running" },
  ],
  result: "The layout is conventional.",
});

function row(trace: SubagentTrace): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-subagent-trace="${trace.id}"]`)!;
}

describe("delegated task timeline row", () => {
  it("shows what the agent is doing, who runs it, on which model, and its steps behind a disclosure", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<SubagentActivityRow trace={agent} />);
    const element = row(agent);
    expect(within(element).getByText("Survey the repository layout")).toBeTruthy();
    expect(element.querySelector(".subagent-activity-meta")?.textContent)
      .toMatch(/^General purpose\s*claude-haiku-4-5\s*Running/u);
    expect(within(element).getByText("Bash · npm test").className).toBe("subagent-activity-doing");

    const steps = within(element).getByRole("button", { name: "Steps for General purpose" });
    expect(steps.getAttribute("aria-expanded")).toBe("false");
    expect(steps.hasAttribute("aria-controls")).toBe(false);
    steps.focus();
    await user.keyboard("{Enter}");
    expect(steps.getAttribute("aria-expanded")).toBe("true");
    const list = document.getElementById(steps.getAttribute("aria-controls")!)!;
    expect(list.tagName).toBe("OL");
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Done: Read · src/index.ts",
      "Failed: Grep · TODO",
      "Running: Bash · npm test",
    ]);
    expect(element.querySelector(".subagent-activity-doing")).toBeNull();

    rerender(<SubagentActivityRow trace={{ ...agent, isLive: false, status: "completed", sequence: 2, durationMs: 65_000 }} />);
    expect(steps.getAttribute("aria-expanded")).toBe("true");
    expect(element.querySelector(".subagent-activity-meta")?.textContent).toMatch(/Completed/u);
    expect(within(row(agent)).getByText("Bash · npm test").closest("li")?.dataset.stepStatus).toBe("unfinished");
    await user.click(steps);
    expect(steps.getAttribute("aria-expanded")).toBe("false");
    const reserved = element.querySelector<HTMLElement>(".subagent-activity-doing")!;
    expect(reserved.getAttribute("aria-hidden")).toBe("true");
    expect(reserved.textContent).toBe(" ");

    const result = within(element).getByRole("button", { name: "Result for General purpose" });
    await user.click(result);
    expect(document.getElementById(result.getAttribute("aria-controls")!)?.textContent).toBe("The layout is conventional.");
  });

  it("qualifies a model that was only requested and renders provider text as plain text", () => {
    const trace = taskTrace({
      id: "trace-requested",
      description: "<img src=x onerror=alert(1)> Check",
      model: "haiku",
      modelSource: "requested",
      providerName: "Scout",
    });
    render(<SubagentActivityRow trace={trace} />);
    expect(row(trace).querySelector("img")).toBeNull();
    expect(within(row(trace)).getByText("<img src=x onerror=alert(1)> Check")).toBeTruthy();
    expect(within(row(trace)).getByText("haiku (requested)")).toBeTruthy();
  });

  it("shows a background command by description with its command, then its completion notice", () => {
    const shell = taskTrace({
      id: "trace-shell",
      taskKind: "shell",
      background: true,
      description: "Start the dev server",
      command: "npm run dev",
      providerName: null,
    });
    const { rerender } = render(<SubagentActivityRow trace={shell} />);
    expect(within(row(shell)).getByText("Start the dev server")).toBeTruthy();
    expect(within(row(shell)).getByText("npm run dev").tagName).toBe("CODE");
    expect(row(shell).querySelector(".subagent-activity-meta")?.textContent).toMatch(/Background command\s*Running in background/u);
    rerender(<SubagentActivityRow trace={{ ...shell, isLive: false, status: "completed", result: "Exited with code 0", sequence: 2 }} />);
    expect(row(shell).querySelector(".subagent-activity-meta")?.textContent).toMatch(/Finished/u);
    expect(within(row(shell)).getByText("Exited with code 0")).toBeTruthy();
    expect(within(row(shell)).queryByRole("button", { name: /Result/u })).toBeNull();
    rerender(<SubagentActivityRow trace={{ ...shell, isLive: false, status: "cancelled", sequence: 3 }} />);
    expect(row(shell).querySelector(".subagent-activity-meta")?.textContent).toMatch(/Stopped/u);
    rerender(<SubagentActivityRow trace={{ ...shell, isLive: false, status: "failed", sequence: 4 }} />);
    expect(row(shell).dataset.activitySeverity).toBe("failure");
  });

  it("titles a command without a description by its command text", () => {
    const shell = taskTrace({ id: "trace-bare", taskKind: "shell", background: true, description: null, command: "python -m http.server", providerName: null });
    render(<SubagentActivityRow trace={shell} />);
    expect(within(row(shell)).getByText("python -m http.server").className).toContain("is-command");
  });

  it("replaces only the tool row that started the task and keeps a live task out of a folded group", () => {
    const linked = activity();
    const plain = activity({ id: "activity-read", title: "Read src/index.ts" });
    const live = { ...agent, result: null };
    render(
      <TurnSubagentActivities subagents={[live]}>
        <ActivityGroup
          entry={{ kind: "activity-group", id: "group-1", createdAt: linked.createdAt, activities: [linked, plain] }}
          settled
        />
      </TurnSubagentActivities>,
    );
    const group = document.querySelector<HTMLElement>("[data-activity-group]")!;
    expect(group.dataset.activityGroupState).toBe("live");
    expect(row(live)).toBeTruthy();
    expect(within(group).getByText("Survey the repository layout")).toBeTruthy();
    expect(group.querySelectorAll(".agent-activity:not(.subagent-activity)")).toHaveLength(1);
  });

  it("falls back to the generic row for legacy traces and lists only traces without a tool row compactly", () => {
    const legacy = taskTrace({ id: "trace-legacy", activityId: null, description: "Legacy review" });
    const codex = taskTrace({ id: "trace-codex", providerId: "codex", activityId: null, description: "Codex child", isLive: false, status: "completed" });
    const stale = taskTrace({ id: "trace-stale", activityId: "activity-gone", description: "Pruned row" });
    const opencode = taskTrace({ id: "trace-opencode", providerId: "opencode", activityId: null, description: "Legacy OpenCode task" });
    render(
      <TurnSubagentActivities subagents={[legacy]}>
        <ActivityGroup entry={{ kind: "activity-group", id: "group-1", createdAt: "2030-01-01T00:00:00.000Z", activities: [activity()] }} />
      </TurnSubagentActivities>,
    );
    expect(document.querySelector(".subagent-activity")).toBeNull();
    expect(screen.getByText("Agent")).toBeTruthy();
    expect(linkedSubagentTraces([legacy, agent]).get("activity-agent")).toBe(agent);
    expect(unlinkedSubagentTraces([legacy, codex, stale, opencode, agent], new Set(["activity-agent"])).map(({ id }) => id))
      .toEqual(["trace-codex"]);
    const many = Array.from({ length: 12 }, (_, index) => taskTrace({
      id: `many-${index}`,
      providerId: "codex",
      isLive: index === 0,
      status: index === 0 ? "running" : "completed",
    }));
    expect(unlinkedSubagentTraces(many, new Set(), 4).map(({ id }) => id)).toEqual(["many-0", "many-9", "many-10", "many-11"]);

    render(<UnlinkedSubagentRows traces={[codex]} />);
    const list = screen.getByRole("list", { name: "Delegated tasks" });
    expect(within(list).getByText("Codex child")).toBeTruthy();
  });

  it("lays the who, model, state and elapsed parts out on one line", () => {
    const style = document.createElement("style");
    style.textContent = ["src/renderer/src/styles.css", "src/renderer/src/components/response-timeline/ActivityGroup.css"]
      .map((path) => readFileSync(path, "utf8"))
      .join(" ");
    document.head.append(style);
    render(<div className="turn-activity-group"><SubagentActivityRow trace={agent} /></div>);
    const meta = row(agent).querySelector<HTMLElement>(".subagent-activity-meta")!;
    expect(getComputedStyle(meta).display).toBe("flex");
    expect(getComputedStyle(meta).flexDirection).toBe("row");
    style.remove();
  });
});
