import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BackgroundTasksSurface,
  type BackgroundTasksSurfaceProps,
} from "../../src/renderer/src/components/BackgroundTasksSurface";
import {
  taskTrace,
  taskTurn,
  taskUsage,
  workspaceRun,
} from "./background-task-fixtures";

const NOW = Date.parse("2030-01-01T00:01:00.000Z");

const turns = [
  taskTurn({ id: "turn-codex", runId: "run-codex", providerId: "codex" }),
  taskTurn({ id: "turn-claude", runId: "run-claude", providerId: "claude" }),
  taskTurn({ id: "turn-opencode", runId: "run-opencode", providerId: "opencode" }),
  taskTurn({ id: "turn-cursor", runId: "run-cursor", providerId: "cursor" }),
];

const codexTask = taskTrace({
  id: "codex-explorer",
  turnId: "turn-codex",
  runId: "run-codex",
  providerId: "codex",
  providerName: "Explorer",
  model: "gpt-5.3-codex",
  activity: "Running rg subagent",
  progress: "Searching the persistence layer",
  usage: taskUsage({
    totalTokens: 128_400,
    inputTokens: 120_000,
    cachedInputTokens: 96_000,
    outputTokens: 8_000,
    reasoningOutputTokens: 400,
    contextTokens: 50_000,
    maxContextTokens: 200_000,
  }),
  toolUseCount: 14,
  sequence: 1,
});

const claudeTask = taskTrace({
  id: "claude-reviewer",
  turnId: "turn-claude",
  runId: "run-claude",
  providerId: "claude",
  providerName: "Reviewer",
  model: "claude-sonnet-4-5",
  status: "completed",
  result: "No regressions found in the adapter.",
  usage: taskUsage({ totalTokens: 9_000 }),
  toolUseCount: 3,
  durationMs: 83_000,
  sequence: 2,
});

const opencodeChild = taskTrace({
  id: "opencode-child",
  turnId: "turn-opencode",
  runId: "run-opencode",
  providerId: "opencode",
  providerName: "Fixture writer",
  parentTraceId: "codex-explorer",
  parentProviderAgentId: "agent-1",
  model: "anthropic/claude-haiku-4-5",
  activity: "Edit tests/fixture.ts",
  sequence: 3,
});

const cursorTask = taskTrace({
  id: "cursor-task",
  turnId: "turn-cursor",
  runId: "run-cursor",
  providerId: "cursor",
  providerName: null,
  providerRole: null,
  description: "Summarize the open review threads",
  model: "gpt-5",
  status: "completed",
  result: "Three threads remain open.",
  durationMs: 4_200,
  sequence: 4,
});

const failedTask = taskTrace({
  id: "claude-failed",
  turnId: "turn-claude",
  runId: "run-claude",
  providerName: "Build verifier",
  status: "failed",
  providerStatus: "error",
  result: "The optional check exited with code 1.",
  sequence: 5,
});

function chat(harnessId: string): BackgroundTasksSurfaceProps["conversation"] {
  return { id: "conversation-1", modelSelection: { harnessId } };
}

function surface(
  overrides: Partial<BackgroundTasksSurfaceProps> = {},
): React.JSX.Element {
  return (
    <BackgroundTasksSurface
      runtimeStatus="online"
      subagents={[codexTask, claudeTask, opencodeChild, cursorTask, failedTask]}
      turns={turns}
      runs={[]}
      conversation={chat("codex-app-server")}
      now={NOW}
      {...overrides}
    />
  );
}

function detail(list: HTMLElement, term: string): HTMLElement | null {
  const label = within(list).queryByText(term, { selector: "dt" });
  return label?.nextElementSibling instanceof HTMLElement ? label.nextElementSibling : null;
}

function row(name: RegExp | string): HTMLElement {
  return screen.getByRole("listitem", { name });
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    media: "",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Background tasks surface", () => {
  it("summarizes every task and the tokens providers reported for some of them", () => {
    render(surface());
    const region = screen.getByRole("region", { name: "Background tasks" });
    expect(within(region).getByRole("heading", { name: "Background tasks", level: 3 })).toBeVisible();
    expect(within(region).getByText("2 active · 1 needs review · 2 finished")).toBeVisible();
    expect(within(region).getByText("137.4K tokens reported by 2 of 5 agents")).toBeVisible();
    expect(within(region).getByText(
      "Sum of what the providers reported for these agents. This chat's own usage is in Usage.",
    )).toBeVisible();
  });

  it("groups live work first, then work needing review, and finished work separately", () => {
    render(surface());
    const active = screen.getByRole("list", { name: "Active" });
    expect(within(active).getAllByRole("listitem").map((item) => item.dataset.taskId))
      .toEqual(["codex-explorer", "opencode-child", "claude-failed"]);
    const finished = screen.getByRole("list", { name: "Finished" });
    expect(within(finished).getAllByRole("listitem").map((item) => item.dataset.taskId))
      .toEqual(["claude-reviewer", "cursor-task"]);
    expect(row(/^Fixture writer/u)).toHaveAttribute("data-depth", "1");
    expect(within(row(/^Fixture writer/u)).getByText("Child of Explorer")).toBeVisible();
  });

  it("shows a Codex task's status, model, current activity, elapsed time and tokens", () => {
    render(surface());
    const codex = row(/^Explorer/u);
    expect(within(codex).getByText("Running", { selector: ".background-task-status" })).toBeVisible();
    expect(within(codex).getByRole("img", { name: "Codex" })).toBeVisible();
    expect(within(codex).getByText("gpt-5.3-codex")).toBeVisible();
    expect(within(codex).getByText("Running rg subagent")).toBeVisible();
    expect(within(codex).getByText("1m")).toBeVisible();
    expect(within(codex).getByText("128.4K")).toBeVisible();
  });

  it("explains missing token counts with a readable reason instead of a bare dash", () => {
    render(surface());
    const cursor = row(/^Summarize the open review threads/u);
    expect(within(cursor).getByText("Three threads remain open.")).toBeVisible();
    expect(within(cursor).getByText("Tokens: Cursor does not report tokens for delegated tasks"))
      .toHaveClass("visually-hidden");
    expect(within(cursor).getByText("—")).toBeVisible();
    expect(within(cursor).getByText("4s")).toBeVisible();
    const live = row(/^Fixture writer/u);
    expect(within(live).getByText("Tokens: Not reported yet")).toBeInTheDocument();
    const failed = row(/^Build verifier/u);
    expect(within(failed).getByText("Failed", { selector: ".background-task-status" }))
      .toBeVisible();
    expect(within(failed).getByText("Tokens: Not reported for this task")).toBeInTheDocument();
  });

  it("opens details with the cumulative total, the latest step, context and runtime", async () => {
    const user = userEvent.setup();
    render(surface());
    const codex = row(/^Explorer/u);
    const details = within(codex).getByRole("button", { name: "Details for Explorer" });
    expect(details).toHaveAttribute("aria-expanded", "false");
    await user.click(details);
    expect(details).toHaveAttribute("aria-expanded", "true");
    const list = document.getElementById(details.getAttribute("aria-controls")!)!;
    expect(detail(list, "Total tokens")).toHaveTextContent(/^128,400$/u);
    expect(detail(list, "Latest step"))
      .toHaveTextContent(/^Input 120K · Cached 96K · Output 8K · Reasoning 400$/u);
    const context = detail(list, "Context")!;
    expect(within(context).getByRole("meter", { name: "Context window remaining" }))
      .toHaveAttribute("aria-valuenow", "75");
    expect(within(context).getByText("75% of 200K remaining")).toBeVisible();
    expect(detail(list, "Tool uses")).toHaveTextContent(/^14$/u);
    expect(detail(list, "Route")).toHaveTextContent("Codex · App Server");
    expect(detail(list, "Model")).toHaveTextContent(/^gpt-5\.3-codex$/u);
    expect(detail(list, "Doing now")).toHaveTextContent(/^Running rg subagent$/u);
    expect(detail(list, "Progress")).toHaveTextContent(/^Searching the persistence layer$/u);
    expect(detail(list, "Latest activity")).toBeNull();

    const claude = row(/^Reviewer/u);
    const claudeDetails = within(claude).getByRole("button", { name: "Details for Reviewer" });
    await user.click(claudeDetails);
    const claudeList = document.getElementById(claudeDetails.getAttribute("aria-controls")!)!;
    expect(detail(claudeList, "Total tokens")).toHaveTextContent(/^9,000$/u);
    expect(detail(claudeList, "Latest step")).toBeNull();
    expect(detail(claudeList, "Context")).toBeNull();
    expect(detail(claudeList, "Runtime")).toHaveTextContent(/^1m 23s$/u);
    expect(detail(claudeList, "Doing now")).toBeNull();

    const cursor = row(/^Summarize the open review threads/u);
    const cursorDetails = within(cursor).getByRole("button", { name: /^Details for/u });
    await user.click(cursorDetails);
    const cursorList = document.getElementById(cursorDetails.getAttribute("aria-controls")!)!;
    expect(detail(cursorList, "Total tokens"))
      .toHaveTextContent(/^Cursor does not report tokens for delegated tasks$/u);
  });

  it("keeps the existing agent actions and offers Stop only where the harness supports it", async () => {
    const user = userEvent.setup();
    const onOpenSubagent = vi.fn();
    const onFollowUpSubagent = vi.fn();
    let resolveStop!: () => void;
    const onStopSubagent = vi.fn(() => new Promise<void>((resolve) => { resolveStop = resolve; }));
    render(surface({
      onOpenSubagent,
      onFollowUpSubagent,
      canFollowUpSubagent: (trace) => trace.id === "opencode-child",
      onStopSubagent,
      canStopSubagent: () => true,
      subagents: [
        codexTask,
        opencodeChild,
        taskTrace({
          id: "claude-live",
          turnId: "turn-claude",
          runId: "run-claude",
          providerName: "Claude helper",
          sequence: 9,
        }),
      ],
    }));
    expect(within(row(/^Explorer/u)).queryByRole("button", { name: /^Stop/u })).toBeNull();
    await user.click(screen.getByRole("button", { name: "View parent turn for Explorer" }));
    expect(onOpenSubagent).toHaveBeenCalledWith(codexTask);
    await user.click(screen.getByRole("button", { name: "Guide parent about Fixture writer" }));
    expect(onFollowUpSubagent).toHaveBeenCalledWith(opencodeChild);
    const stop = screen.getByRole("button", { name: "Stop Claude helper" });
    await user.click(stop);
    expect(onStopSubagent).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Stopping Claude helper" })).toBeDisabled();
    resolveStop();
    expect(await screen.findByRole("button", { name: "Stop Claude helper" })).toBeEnabled();
  });

  it("compacts finished tasks beyond five and reveals them on request", async () => {
    const user = userEvent.setup();
    const finished = Array.from({ length: 8 }, (_, index) => taskTrace({
      id: `done-${index}`,
      providerName: `Done ${index}`,
      status: "completed",
      sequence: index + 1,
    }));
    render(surface({ subagents: finished, turns: [taskTurn()] }));
    const list = screen.getByRole("list", { name: "Finished" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    const toggle = screen.getByRole("button", { name: "Show 3 more finished tasks" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", list.id);
    await user.click(toggle);
    expect(within(list).getAllByRole("listitem")).toHaveLength(8);
    expect(screen.getByRole("button", { name: "Show fewer finished tasks" }))
      .toHaveAttribute("aria-expanded", "true");
  });

  it("lists this chat's commands with their state and the existing Stop and Dismiss commands", async () => {
    const user = userEvent.setup();
    const onStopCommand = vi.fn();
    const onDismissCommand = vi.fn();
    const live = workspaceRun({ id: "dev", kind: "service", label: "npm run dev", detail: "http://localhost:5173", port: 5173 });
    const failed = workspaceRun({
      id: "lint",
      label: "npm run lint",
      detail: "2 problems",
      status: "failed",
      attentionState: "unseen",
      canStop: false,
      startedAt: "2030-01-01T00:00:20.000Z",
      finishedAt: "2030-01-01T00:00:50.000Z",
    });
    render(surface({
      subagents: [],
      runs: [live, failed],
      onStopCommand,
      onDismissCommand,
    }));
    expect(screen.getByText("1 active · 1 needs review")).toBeVisible();
    const commands = screen.getByRole("list", { name: "Commands" });
    const devRow = within(commands).getByRole("listitem", { name: /^npm run dev/u });
    expect(within(devRow).getByText("http://localhost:5173")).toBeVisible();
    expect(within(devRow).getByText("Running")).toBeVisible();
    expect(within(devRow).getByText("50s")).toBeVisible();
    expect(within(devRow).queryByText(/tokens/iu)).toBeNull();
    expect(within(devRow).queryByRole("button", { name: /Dismiss/u })).toBeNull();
    await user.click(within(devRow).getByRole("button", { name: "Stop npm run dev" }));
    expect(onStopCommand).toHaveBeenCalledWith(live);
    const lintRow = within(commands).getByRole("listitem", { name: /^npm run lint/u });
    expect(within(lintRow).getByText("Failed", { selector: ".background-task-status" })).toBeVisible();
    expect(within(lintRow).getByText("30s")).toBeVisible();
    expect(within(lintRow).queryByRole("button", { name: /^Stop/u })).toBeNull();
    await user.click(within(lintRow).getByRole("button", { name: "Dismiss npm run lint" }));
    expect(onDismissCommand).toHaveBeenCalledWith(failed);
    expect(screen.queryByRole("list", { name: "Active" })).toBeNull();
  });

  it.each([
    ["kimi-acp", "Kimi Code does not report delegated agents. Commands it starts appear here."],
    ["antigravity-cli", "Antigravity does not report delegated agents. Commands it starts appear here."],
    ["cursor-acp", "Cursor reports a delegated task when it finishes."],
  ])("explains the empty state for %s", (harnessId, note) => {
    render(surface({ subagents: [], runs: [], turns: [], conversation: chat(harnessId) }));
    expect(screen.getByText("No background tasks in this chat.")).toBeVisible();
    expect(screen.getByText(note)).toBeVisible();
    expect(screen.queryByText(/tokens reported/u)).toBeNull();
  });

  it("keeps the empty state plain for harnesses that report agents", () => {
    const view = render(surface({ subagents: [], runs: [], turns: [], conversation: chat("codex-app-server") }));
    expect(screen.getByText("No background tasks in this chat.")).toBeVisible();
    expect(view.container.querySelector(".background-tasks-note")).toBeNull();
    view.rerender(surface({
      subagents: [],
      runs: [workspaceRun()],
      turns: [],
      conversation: chat("kimi-acp"),
    }));
    expect(screen.queryByText("No background tasks in this chat.")).toBeNull();
    expect(screen.getByText("Kimi Code does not report delegated agents. Commands it starts appear here."))
      .toBeVisible();
  });

  it("promotes runtime status only when attention is required", () => {
    const view = render(surface());
    expect(screen.queryByText(/workspace runtime/iu)).toBeNull();
    view.rerender(surface({ runtimeStatus: "connecting" }));
    expect(screen.getByRole("status")).toHaveTextContent("Connecting to workspace");
    view.rerender(surface({ runtimeStatus: "offline" }));
    expect(screen.getByRole("status")).toHaveTextContent("Workspace runtime unavailable");
  });

  it("keeps labelling unique across split surfaces and labels every button", () => {
    const view = render(<>{surface({ runs: [workspaceRun()] })}{surface({ runs: [workspaceRun()] })}</>);
    const references = [...view.container.querySelectorAll<HTMLElement>("[aria-labelledby], [aria-controls]")]
      .flatMap((element) => [
        element.getAttribute("aria-labelledby"),
        element.getAttribute("aria-controls"),
      ])
      .filter((value): value is string => value !== null);
    expect(references.length).toBeGreaterThan(4);
    for (const id of references) expect(document.getElementById(id)).not.toBeNull();
    const labelled = [...view.container.querySelectorAll<HTMLElement>("[aria-labelledby]")]
      .map((element) => element.getAttribute("aria-labelledby"));
    expect(new Set(labelled).size).toBe(labelled.length);
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveAccessibleName();
    }
  });
});

describe("Background tasks stylesheet", () => {
  const css = readFileSync("src/renderer/src/components/BackgroundTasksSurface.css", "utf8");

  it("uses semantic colour tokens only so preset and custom themes apply", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(css).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/u);
  });

  it("adapts to narrow containers, reduced motion, forced colours and hidden documents", () => {
    expect(css).toMatch(/@container background-tasks \(max-width: 440px\)/u);
    expect(css).toMatch(/@container background-tasks \(max-width: 360px\)/u);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/u);
    expect(css).toMatch(/@media \(forced-colors: active\)/u);
    expect(css).toMatch(/\[data-document-visible="false"\]/u);
  });
});
