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
});

const childTask = taskTrace({
  id: "opencode-child",
  turnId: "turn-opencode",
  runId: "run-opencode",
  providerId: "opencode",
  providerName: "Fixture writer",
  parentTraceId: "codex-explorer",
  activity: "Edit tests/fixture.ts",
});

const claudeTask = taskTrace({
  id: "claude-reviewer",
  turnId: "turn-claude",
  runId: "run-claude",
  providerName: "Reviewer",
  model: "claude-sonnet-4-5",
  status: "completed",
  result: "No regressions found in the adapter.",
  usage: taskUsage({ totalTokens: 9_000 }),
  toolUseCount: 3,
  durationMs: 83_000,
  createdAt: "2030-01-01T00:00:02.000Z",
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
  createdAt: "2030-01-01T00:00:03.000Z",
});

const failedTask = taskTrace({
  id: "claude-failed",
  turnId: "turn-claude",
  runId: "run-claude",
  providerName: "Build verifier",
  status: "failed",
  providerStatus: "error",
  result: "The optional check exited with code 1.",
  createdAt: "2030-01-01T00:00:04.000Z",
});

function surface(overrides: Partial<BackgroundTasksSurfaceProps> = {}): React.JSX.Element {
  return (
    <BackgroundTasksSurface
      runtimeStatus="online"
      subagents={[codexTask, childTask, claudeTask, cursorTask, failedTask]}
      turns={turns}
      runs={[]}
      conversationId="conversation-1"
      now={NOW}
      onOpenSubagent={vi.fn()}
      {...overrides}
    />
  );
}

function card(title: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^${title}`, "u") }).closest("li")!;
}

function detail(list: HTMLElement, term: string): HTMLElement | null {
  const label = within(list).queryByText(term, { selector: "dt" });
  return label?.nextElementSibling instanceof HTMLElement ? label.nextElementSibling : null;
}

async function openDetails(title: string): Promise<HTMLElement> {
  const toggle = screen.getByRole("button", { name: new RegExp(`^${title}`, "u") });
  await userEvent.setup().click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  return document.getElementById(toggle.getAttribute("aria-controls")!)!;
}

async function openFinished(): Promise<HTMLElement> {
  await userEvent.setup().click(screen.getByRole("button", { name: /^Finished/u }));
  return screen.getByRole("list", { name: "Finished" });
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
  it("lists running work as plain cards under one quiet label, without a summary header", () => {
    render(surface());
    const region = screen.getByRole("region", { name: "Background tasks" });
    const running = within(region).getByRole("list", { name: "Running" });
    expect(within(running).getAllByRole("listitem")).toHaveLength(2);
    expect(within(region).queryByRole("heading")).toBeNull();
    expect(within(region).queryByText(/tokens reported/u)).toBeNull();
    const explorer = card("Explorer");
    expect(explorer).toHaveTextContent("Agent");
    expect(within(explorer).getByText("1m")).toBeVisible();
    expect(within(explorer).getByText("gpt-5.3-codex")).toBeVisible();
    expect(explorer).toHaveTextContent("128.4K tokens");
    expect(explorer).toHaveTextContent("14 tool uses");
    expect(within(explorer).getByText("Running rg subagent")).toBeVisible();
    expect(within(explorer).getByRole("button", { name: "View turn for Explorer" })).toBeVisible();
  });

  it("names a child agent's parent instead of indenting it", () => {
    render(surface());
    const child = card("Fixture writer");
    expect(child).toHaveTextContent("Agent · from Explorer");
    expect(child).not.toHaveAttribute("data-depth");
    expect(child.closest("ol")).toBe(card("Explorer").closest("ol"));
  });

  it("collapses finished work into one row that counts failures in words", async () => {
    render(surface());
    const toggle = screen.getByRole("button", { name: "Finished 3 · 1 failed" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Finished" })).toBeNull();
    const finished = await openFinished();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", finished.id);
    expect(within(finished).getAllByRole("listitem").map((item) => item.dataset.focusRow))
      .toEqual(["agent:claude-failed", "agent:cursor-task", "agent:claude-reviewer"]);
    const failed = card("Build verifier");
    expect(within(failed).getByText("Failed")).toHaveClass("background-task-danger");
    expect(failed).toHaveTextContent("Agent · Failed");
  });

  it("shows tokens on a card only when reported and explains Cursor only in Details", async () => {
    render(surface());
    await openFinished();
    const cursor = card("Summarize the open review threads");
    expect(cursor).not.toHaveTextContent(/tokens/u);
    expect(cursor).toHaveTextContent("gpt-5");
    const details = await openDetails("Summarize the open review threads");
    expect(detail(details, "Tokens")).toHaveTextContent(/^Not reported by Cursor$/u);
    expect(detail(details, "Total tokens")).toBeNull();
  });

  it("expands a card in place into plain label and value rows", async () => {
    render(surface());
    const details = await openDetails("Explorer");
    expect(detail(details, "Task")).toHaveTextContent("Inspect the provider lifecycle.");
    expect(detail(details, "Progress")).toHaveTextContent(/^Searching the persistence layer$/u);
    expect(detail(details, "Total tokens")).toHaveTextContent(/^128,400$/u);
    expect(detail(details, "Latest step"))
      .toHaveTextContent(/^Input 120K · Cached 96K · Output 8K · Reasoning 400$/u);
    const context = detail(details, "Context")!;
    expect(within(context).getByRole("meter", { name: "Context window remaining" }))
      .toHaveAttribute("aria-valuenow", "75");
    expect(within(context).getByText("75% of 200K remaining")).toBeVisible();
    expect(detail(details, "Tool uses")).toHaveTextContent(/^14$/u);
    expect(detail(details, "Route")).toHaveTextContent("Codex · App Server");
    expect(detail(details, "Provider state")).toBeNull();
    expect(detail(details, "Runtime")).toBeNull();
  });

  it("shows a waiting task's state and provider state instead of its last tool", async () => {
    const waiting = taskTrace({
      id: "waiting",
      turnId: "turn-opencode",
      providerId: "opencode",
      providerName: "Schema checker",
      status: "waiting",
      providerStatus: "idle",
      activity: "Edit tests/fixture.ts",
      progress: null,
    });
    render(surface({ subagents: [waiting] }));
    const item = card("Schema checker");
    expect(item).toHaveTextContent("Agent · Waiting");
    expect(item).not.toHaveTextContent("Edit tests/fixture.ts");
    const details = await openDetails("Schema checker");
    expect(detail(details, "Provider state")).toHaveTextContent(/^idle$/u);
  });

  it("omits the runtime of a lost task instead of counting the downtime", async () => {
    const lost = taskTrace({
      id: "lost",
      providerName: "Recovered",
      status: "lost",
      isLive: false,
      updatedAt: "2030-01-04T00:00:00.000Z",
    });
    render(surface({ subagents: [lost], now: Date.parse("2030-01-05T00:00:00.000Z") }));
    await openFinished();
    const item = card("Recovered");
    expect(item).toHaveTextContent("Agent · Lost");
    expect(item.querySelector(".subagent-elapsed")).toBeNull();
    const details = await openDetails("Recovered");
    expect(detail(details, "Runtime")).toHaveTextContent(/^Not reported$/u);
  });

  it("wires View turn, Guide parent and Stop without toggling the card", async () => {
    const user = userEvent.setup();
    const onOpenSubagent = vi.fn();
    const onFollowUpSubagent = vi.fn();
    let resolveStop!: () => void;
    const onStopSubagent = vi.fn(() => new Promise<void>((resolve) => { resolveStop = resolve; }));
    const helper = taskTrace({ id: "claude-live", turnId: "turn-claude", providerName: "Claude helper" });
    render(surface({
      subagents: [codexTask, helper],
      onOpenSubagent,
      onFollowUpSubagent,
      canFollowUpSubagent: (trace) => trace.id === "claude-live",
      onStopSubagent,
      canStopSubagent: () => true,
    }));
    expect(screen.queryByRole("button", { name: "Stop Explorer" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "View turn for Explorer" }));
    expect(onOpenSubagent).toHaveBeenCalledWith(codexTask);
    expect(screen.getByRole("button", { name: /^Explorer/u })).toHaveAttribute("aria-expanded", "false");
    await openDetails("Claude helper");
    await user.click(screen.getByRole("button", { name: "Guide parent about Claude helper" }));
    expect(onFollowUpSubagent).toHaveBeenCalledWith(helper);
    const toggle = screen.getByRole("button", { name: /^Claude helper/u });
    await user.click(screen.getByRole("button", { name: "Stop Claude helper" }));
    expect(onStopSubagent).toHaveBeenCalledOnce();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Stopping Claude helper" })).toBeDisabled();
    resolveStop();
    expect(await screen.findByRole("button", { name: "Stop Claude helper" })).toBeEnabled();
  });

  it("shows commands as short cards and dismisses finished ones from the Finished row", async () => {
    const user = userEvent.setup();
    const onStopCommand = vi.fn();
    const onDismissCommand = vi.fn();
    const dev = workspaceRun({ id: "dev", kind: "service", label: "npm run dev", detail: "http://localhost:5173", port: 5173 });
    const lint = workspaceRun({
      id: "lint",
      label: "npm run lint",
      status: "failed",
      attentionState: "unseen",
      canStop: false,
      startedAt: "2030-01-01T00:00:20.000Z",
      finishedAt: "2030-01-01T00:00:50.000Z",
    });
    const build = workspaceRun({
      id: "build",
      label: "npm run build",
      status: "succeeded",
      canStop: false,
      startedAt: "2030-01-01T00:00:30.000Z",
      finishedAt: "2030-01-01T00:00:40.000Z",
    });
    const view = render(surface({ subagents: [], runs: [dev, lint, build], onStopCommand, onDismissCommand }));
    const devCard = screen.getByText("npm run dev").closest("li")!;
    expect(devCard).toHaveTextContent("Command");
    expect(within(devCard).getByText("50s")).toBeVisible();
    expect(within(devCard).getByText("http://localhost:5173")).toBeVisible();
    expect(devCard).not.toHaveTextContent(/tokens/u);
    await user.click(within(devCard).getByRole("button", { name: "Stop npm run dev" }));
    expect(onStopCommand).toHaveBeenCalledWith(dev);
    expect(screen.getByRole("button", { name: "Finished 2 · 1 failed" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Dismiss finished commands" }));
    expect(onDismissCommand.mock.calls.map(([run]) => run.id)).toEqual(["build", "lint"]);
    view.rerender(surface({
      subagents: [claudeTask],
      runs: [dev],
      onStopCommand,
      onDismissCommand,
    }));
    expect(screen.queryByRole("button", { name: "Dismiss finished commands" })).toBeNull();
  });

  it("compacts open finished work to twenty cards and reveals the rest on request", async () => {
    const user = userEvent.setup();
    const finished = Array.from({ length: 24 }, (_, index) => taskTrace({
      id: `done-${String(index).padStart(2, "0")}`,
      providerName: `Done ${index}`,
      status: "completed",
      createdAt: `2030-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    }));
    render(surface({ subagents: finished }));
    const list = await openFinished();
    expect(within(list).getAllByRole("listitem")).toHaveLength(20);
    expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("Done 23");
    await user.click(screen.getByRole("button", { name: "Show 4 more finished tasks" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(24);
  });

  it("says only that there are no background tasks when the chat has none", () => {
    render(surface({ subagents: [], runs: [], turns: [taskTurn({ providerId: "kimi" })] }));
    expect(screen.getByText("No background tasks.")).toBeVisible();
    expect(screen.queryByText(/Kimi/u)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("promotes runtime status only when attention is required", () => {
    const view = render(surface());
    expect(screen.queryByText(/workspace runtime/iu)).toBeNull();
    view.rerender(surface({ runtimeStatus: "connecting" }));
    expect(screen.getByRole("status")).toHaveTextContent("Connecting to workspace");
    view.rerender(surface({ runtimeStatus: "offline" }));
    expect(screen.getByRole("status")).toHaveTextContent("Workspace runtime unavailable");
  });

  it("never nests a control inside another and labels every control", async () => {
    const view = render(<>{surface({ runs: [workspaceRun()] })}{surface({ runs: [workspaceRun()] })}</>);
    for (const toggle of screen.getAllByRole("button", { name: /^Explorer/u })) {
      await userEvent.setup().click(toggle);
    }
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveAccessibleName();
      expect(button.parentElement?.closest("button, a, [role='button']")).toBeNull();
    }
    const references = [...view.container.querySelectorAll<HTMLElement>("[aria-labelledby], [aria-controls]")]
      .flatMap((element) => [element.getAttribute("aria-labelledby"), element.getAttribute("aria-controls")])
      .filter((value): value is string => value !== null);
    expect(new Set(references).size).toBe(references.length);
    for (const id of references) expect(document.getElementById(id)).not.toBeNull();
  });
});

describe("Background tasks stylesheet", () => {
  const css = readFileSync("src/renderer/src/components/BackgroundTasksSurface.css", "utf8");

  it("uses semantic colour tokens only so preset and custom themes apply", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(css).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/u);
  });

  it("stays plain: no shadows, uppercase labels or pill shapes", () => {
    expect(css).not.toMatch(/box-shadow|text-transform|999px/u);
  });

  it("adapts to narrow containers, reduced motion and forced colours", () => {
    expect(css).toMatch(/@container background-tasks \(max-width: 360px\)/u);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/u);
    expect(css).toMatch(/@media \(forced-colors: active\)/u);
  });
});
