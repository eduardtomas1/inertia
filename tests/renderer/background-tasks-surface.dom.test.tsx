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
import { backgroundTaskTitle } from "../../src/renderer/src/utils/backgroundTasks";
import { canBackgroundSubagentTrace } from "../../src/renderer/src/utils/subagentDisclosure";

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
  description: "Map the persistence layer",
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
  description: "Write the fixture",
  parentTraceId: "codex-explorer",
  activity: "Edit tests/fixture.ts",
});

const claudeTask = taskTrace({
  id: "claude-reviewer",
  turnId: "turn-claude",
  runId: "run-claude",
  providerName: "Reviewer",
  description: "Review the adapter",
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
  description: "Verify the build",
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
  return screen.getByText(title, { selector: ".background-task-title" }).closest("li")!;
}

async function openTranscript(title: string): Promise<HTMLElement> {
  const toggle = within(card(title)).getByRole("button", { name: /^View transcript for /u });
  await userEvent.setup().click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  return document.getElementById(toggle.getAttribute("aria-controls")!)!;
}

async function openFinished(): Promise<HTMLElement> {
  await userEvent.setup().click(screen.getByRole("button", { name: /^Finished/u }));
  return screen.getByRole("list", { name: "Finished" });
}

function paragraphs(element: HTMLElement): string[] {
  return [...element.querySelectorAll("p")].map((paragraph) => paragraph.textContent ?? "");
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
  it("lists running work as plain cards whose body is not a control", () => {
    render(surface());
    const region = screen.getByRole("region", { name: "Background tasks" });
    const running = within(region).getByRole("list", { name: "Running" });
    expect(within(running).getAllByRole("listitem")).toHaveLength(2);
    expect(within(region).queryByRole("heading")).toBeNull();
    const explorer = card("Map the persistence layer");
    expect(explorer).toHaveTextContent("Agent");
    expect(within(explorer).getByText("1m")).toBeVisible();
    expect(within(explorer).getByText("gpt-5.3-codex")).toBeVisible();
    expect(explorer).toHaveTextContent("128.4K tokens");
    expect(explorer).toHaveTextContent("14 tool uses");
    expect(within(explorer).getByText("Running rg subagent")).toBeVisible();
    expect(screen.getByText("Map the persistence layer", { selector: ".background-task-title" }).closest("button")).toBeNull();
    expect(within(explorer).getAllByRole("button").map((button) => button.getAttribute("aria-label")))
      .toEqual(["View transcript for Explorer"]);
  });

  it("keeps the transcript collapsed until asked and wires it to the card", async () => {
    render(surface());
    const toggle = screen.getByRole("button", { name: "View transcript for Explorer" });
    expect(toggle).toHaveTextContent("View transcript");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).not.toHaveAttribute("aria-controls");
    expect(card("Map the persistence layer").querySelector(".background-task-transcript")).toBeNull();
    const transcript = await openTranscript("Map the persistence layer");
    expect(card("Map the persistence layer")).toContainElement(transcript);
  });

  it("reads like a short transcript: task, progress, one meta line and quiet links", async () => {
    render(surface({ onFollowUpSubagent: vi.fn(), canFollowUpSubagent: () => true }));
    const transcript = await openTranscript("Map the persistence layer");
    expect(paragraphs(transcript)).toEqual([
      "Searching the persistence layer",
      "Input 120K · Cached 96K · Output 8K · Reasoning 400 · 75% context left",
    ]);
    expect(within(transcript).getByRole("button", { name: "View turn for Explorer" })).toBeVisible();
    expect(within(transcript).getByRole("button", { name: "Guide parent about Explorer" })).toBeVisible();
    expect(transcript.querySelector("dl, [role='meter']")).toBeNull();
    expect(transcript).not.toHaveTextContent(/Route|Tool uses|Total tokens|Provider state|Runtime/u);
  });

  it("puts the outcome first in a finished task's transcript", async () => {
    render(surface());
    await openFinished();
    const transcript = await openTranscript("Review the adapter");
    expect(paragraphs(transcript)).toEqual([
      "No regressions found in the adapter.",
    ]);
    expect(within(card("Review the adapter")).getAllByText("No regressions found in the adapter.")).toHaveLength(1);
  });

  it("names a harness that never reports tokens only inside the transcript", async () => {
    render(surface());
    await openFinished();
    const cursor = card("Summarize the open review threads");
    expect(cursor).not.toHaveTextContent(/tokens/u);
    const transcript = await openTranscript("Summarize the open review threads");
    expect(paragraphs(transcript)).toContain("Tokens not reported by Cursor");
  });

  it("clamps long text and offers Show more", async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function scrollHeight(this: HTMLElement) {
      return this.classList.contains("background-task-clamp") && this.dataset.open !== "true" ? 200 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(80);
    const long = { ...codexTask, description: "A long task ".repeat(80) };
    render(surface({ subagents: [long] }));
    const transcript = await openTranscript(backgroundTaskTitle(long));
    const clamps = [...transcript.querySelectorAll<HTMLElement>(".background-task-clamp")];
    expect(clamps.map((clamp) => clamp.style.getPropertyValue("--clamp-lines"))).toEqual(["4", "6"]);
    const more = within(transcript).getAllByRole("button", { name: /^Show more/u })[0]!;
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(more).toHaveAttribute("aria-controls", clamps[0]!.id);
    await user.click(more);
    expect(clamps[0]).toHaveAttribute("data-open", "true");
    expect(within(transcript).getAllByRole("button", { name: /^Show less/u })[0]).toHaveAttribute("aria-expanded", "true");
  });

  it("names a child agent's parent instead of indenting it", () => {
    render(surface());
    const child = card("Write the fixture");
    expect(child).toHaveTextContent("Agent · Fixture writer · from Map the persistence layer");
    expect(child.closest("ol")).toBe(card("Map the persistence layer").closest("ol"));
  });

  it("collapses finished work into one row that counts failures in words", async () => {
    render(surface());
    const toggle = screen.getByRole("button", { name: "Finished 3 · 1 failed" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const finished = await openFinished();
    expect(toggle).toHaveAttribute("aria-controls", finished.id);
    expect(within(finished).getAllByRole("listitem").map((item) => item.dataset.focusRow))
      .toEqual(["agent:claude-failed", "agent:cursor-task", "agent:claude-reviewer"]);
    const failed = card("Verify the build");
    expect(within(failed).getByText("Failed")).toHaveClass("background-task-danger");
    expect(failed).toHaveTextContent("Agent · Build verifier · Failed");
  });

  it("animates the line of running work only, with the timeline's thinking sweep", () => {
    const waiting = taskTrace({
      id: "waiting",
      providerName: "Schema checker",
      description: "Check the schema",
      status: "waiting",
      activity: "Edit tests/fixture.ts",
      progress: "Waiting for review",
    });
    render(surface({ subagents: [codexTask, waiting, claudeTask] }));
    expect(within(card("Map the persistence layer")).getByText("Running rg subagent")).toHaveClass("background-task-live");
    const waitingCard = card("Check the schema");
    expect(waitingCard).toHaveTextContent("Agent · Schema checker · Waiting");
    expect(waitingCard).not.toHaveTextContent("Edit tests/fixture.ts");
    expect(within(waitingCard).getByText("Waiting for review")).not.toHaveClass("background-task-live");
    expect(screen.getByText("Map the persistence layer", { selector: ".background-task-title" })).not.toHaveClass("background-task-live");
  });

  it("keeps the moving line of an expanded running task and shows its sentence once", async () => {
    const summarized = taskTrace({
      id: "claude-summarized",
      turnId: "turn-claude",
      runId: "run-claude",
      providerName: "Code reviewer",
      description: "Review the usage refactor for regressions.",
      activity: "Reading the provider adapters",
      progress: "Reading the provider adapters",
    });
    render(surface({ subagents: [summarized] }));
    const transcript = await openTranscript("Review the usage refactor for regressions.");
    const lines = within(card("Review the usage refactor for regressions.")).getAllByText("Reading the provider adapters");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveClass("background-task-live");
    expect(paragraphs(transcript)).toEqual([]);
  });

  it("omits the runtime of a lost task instead of counting the downtime", async () => {
    const lost = taskTrace({
      id: "lost",
      providerName: "Recovered",
      description: "Recover the run",
      status: "lost",
      isLive: false,
      updatedAt: "2030-01-04T00:00:00.000Z",
    });
    render(surface({ subagents: [lost], now: Date.parse("2030-01-05T00:00:00.000Z") }));
    await openFinished();
    const item = card("Recover the run");
    expect(item).toHaveTextContent("Agent · Recovered · Lost");
    expect(item.querySelector(".subagent-elapsed")).toBeNull();
  });

  it("wires View turn, Guide parent and Stop without opening or closing the transcript", async () => {
    const user = userEvent.setup();
    const onOpenSubagent = vi.fn();
    const onFollowUpSubagent = vi.fn();
    let resolveStop!: () => void;
    const onStopSubagent = vi.fn(() => new Promise<void>((resolve) => { resolveStop = resolve; }));
    const helper = taskTrace({ id: "claude-live", turnId: "turn-claude", providerName: "Claude helper", description: "Help with Claude" });
    render(surface({
      subagents: [codexTask, helper],
      onOpenSubagent,
      onFollowUpSubagent,
      canFollowUpSubagent: (trace) => trace.id === "claude-live",
      onStopSubagent,
      canStopSubagent: () => true,
    }));
    expect(screen.queryByRole("button", { name: "Stop Explorer" })).toBeNull();
    await openTranscript("Map the persistence layer");
    await user.click(screen.getByRole("button", { name: "View turn for Explorer" }));
    expect(onOpenSubagent).toHaveBeenCalledWith(codexTask);
    expect(screen.getByRole("button", { name: "View transcript for Explorer" })).toHaveAttribute("aria-expanded", "true");
    await openTranscript("Help with Claude");
    await user.click(screen.getByRole("button", { name: "Guide parent about Claude helper" }));
    expect(onFollowUpSubagent).toHaveBeenCalledWith(helper);
    await user.click(screen.getByRole("button", { name: "Stop Claude helper" }));
    expect(onStopSubagent).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "View transcript for Claude helper" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Stopping Claude helper" })).toBeDisabled();
    resolveStop();
    expect(await screen.findByRole("button", { name: "Stop Claude helper" })).toBeEnabled();
  });

  it("titles an agent by its task, names its role on the kind line and qualifies a requested model", () => {
    const requested = taskTrace({
      id: "requested",
      turnId: "turn-claude",
      providerRole: "general-purpose",
      providerName: null,
      description: "Audit the migrations",
      model: "haiku",
      modelSource: "requested",
      steps: [{ label: "Read · migrations/107.ts", status: "running" }],
    });
    render(surface({ subagents: [requested] }));
    const item = card("Audit the migrations");
    expect(item).toHaveTextContent("Agent · General purpose");
    expect(within(item).getByText("haiku (requested)")).toBeVisible();
    expect(within(item).getByText("Read · migrations/107.ts")).toHaveClass("background-task-live");
  });

  it("moves a foreground Claude agent to the background on request", async () => {
    const user = userEvent.setup();
    let resolveMove!: () => void;
    const onBackgroundSubagent = vi.fn(() => new Promise<void>((resolve) => { resolveMove = resolve; }));
    const foreground = taskTrace({ id: "fg", turnId: "turn-claude", description: "Audit the cache", background: false });
    const background = taskTrace({ id: "bg", turnId: "turn-claude", description: "Index the docs", background: true });
    const claudeTurns = [taskTurn({ id: "turn-claude", runId: "run-claude", providerId: "claude", status: "running" })];
    render(surface({
      subagents: [foreground, background],
      turns: claudeTurns,
      onBackgroundSubagent,
      canBackgroundSubagent: (trace) => canBackgroundSubagentTrace(trace, claudeTurns),
    }));
    expect(within(card("Index the docs")).queryByRole("button", { name: /to the background/u })).toBeNull();
    const move = within(card("Audit the cache")).getByRole("button", { name: "Move Evidence scout to the background" });
    await user.click(move);
    expect(onBackgroundSubagent).toHaveBeenCalledWith(foreground);
    expect(move).toBeDisabled();
    resolveMove();
    await vi.waitFor(() => expect(move).toBeEnabled());
  });

  it("moves focus to the card when Move to background goes away under the keyboard", async () => {
    const user = userEvent.setup();
    const onBackgroundSubagent = vi.fn(async () => undefined);
    const foreground = taskTrace({ id: "fg", turnId: "turn-claude", description: "Audit the cache", background: false });
    const claudeTurns = [taskTurn({ id: "turn-claude", runId: "run-claude", providerId: "claude", status: "running" })];
    const props = {
      turns: claudeTurns,
      onBackgroundSubagent,
      canBackgroundSubagent: (trace: Parameters<typeof canBackgroundSubagentTrace>[0]) => canBackgroundSubagentTrace(trace, claudeTurns),
    };
    const view = render(surface({ ...props, subagents: [foreground] }));
    const move = within(card("Audit the cache")).getByRole("button", { name: "Move Evidence scout to the background" });
    move.focus();
    await user.keyboard("{Enter}");
    expect(onBackgroundSubagent).toHaveBeenCalledWith(foreground);
    view.rerender(surface({ ...props, subagents: [{ ...foreground, background: true, sequence: 2 }] }));
    expect(within(card("Audit the cache")).queryByRole("button", { name: /to the background/u })).toBeNull();
    expect(document.activeElement).toBe(card("Audit the cache"));
  });

  it("leaves focus alone when Move to background goes away while focus is elsewhere", () => {
    const foreground = taskTrace({ id: "fg", turnId: "turn-claude", description: "Audit the cache", background: false });
    const claudeTurns = [taskTurn({ id: "turn-claude", runId: "run-claude", providerId: "claude", status: "running" })];
    const props = {
      turns: claudeTurns,
      onBackgroundSubagent: vi.fn(async () => undefined),
      canBackgroundSubagent: (trace: Parameters<typeof canBackgroundSubagentTrace>[0]) => canBackgroundSubagentTrace(trace, claudeTurns),
    };
    const view = render(surface({ ...props, subagents: [foreground] }));
    const transcript = within(card("Audit the cache")).getByRole("button", { name: /^View transcript for/u });
    within(card("Audit the cache")).getByRole("button", { name: /to the background/u }).focus();
    transcript.focus();
    view.rerender(surface({ ...props, subagents: [{ ...foreground, background: true, sequence: 2 }] }));
    expect(document.activeElement).toBe(transcript);
  });

  it("shows a background command with its command and stops it through the task stop", async () => {
    const user = userEvent.setup();
    let resolveStop!: () => void;
    const onStopSubagent = vi.fn(() => new Promise<void>((resolve) => { resolveStop = resolve; }));
    const shell = taskTrace({
      id: "shell-dev",
      turnId: "turn-claude",
      providerTaskId: "shell-task",
      providerName: null,
      taskKind: "shell",
      background: true,
      description: "Start the dev server",
      command: "npm run dev -- --port 5173",
    });
    const finishedShell = taskTrace({
      id: "shell-build",
      turnId: "turn-claude",
      providerName: null,
      taskKind: "shell",
      background: true,
      description: null,
      command: "npm run build",
      status: "failed",
      result: "Build failed with exit code 2",
      createdAt: "2030-01-01T00:00:05.000Z",
    });
    render(surface({
      subagents: [shell, finishedShell],
      turns: [taskTurn({ id: "turn-claude", runId: "run-claude", providerId: "claude", status: "running" })],
      onStopSubagent,
      canStopSubagent: () => true,
    }));
    const item = card("Start the dev server");
    expect(item).toHaveTextContent("Background command · Running in background");
    expect(within(item).getByText("npm run dev -- --port 5173").tagName).toBe("CODE");
    expect(within(item).queryByRole("button", { name: /View transcript/u })).toBeNull();
    await user.click(within(item).getByRole("button", { name: "Stop Background command: Start the dev server" }));
    expect(onStopSubagent).toHaveBeenCalledWith(shell);
    expect(within(item).getByRole("button", { name: "Stopping Background command: Start the dev server" })).toBeDisabled();
    resolveStop();
    await openFinished();
    const failed = card("npm run build");
    expect(failed).toHaveTextContent("Background command · Failed");
    expect(within(failed).getByText("Build failed with exit code 2")).toBeVisible();
    expect(within(failed).queryByRole("button", { name: /^Stop/u })).toBeNull();
  });

  it("shows commands as short cards without a transcript and dismisses finished ones", async () => {
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
    const devCard = card("npm run dev");
    expect(devCard).toHaveTextContent("Command");
    expect(within(devCard).getByText("50s")).toBeVisible();
    expect(within(devCard).getByText("http://localhost:5173")).toBeVisible();
    expect(within(devCard).queryByRole("button", { name: /View transcript/u })).toBeNull();
    await user.click(within(devCard).getByRole("button", { name: "Stop npm run dev" }));
    expect(onStopCommand).toHaveBeenCalledWith(dev);
    expect(screen.getByRole("button", { name: "Finished 2 · 1 failed" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Dismiss finished commands" }));
    expect(onDismissCommand.mock.calls.map(([run]) => run.id)).toEqual(["build", "lint"]);
    view.rerender(surface({ subagents: [claudeTask], runs: [dev], onStopCommand, onDismissCommand }));
    expect(screen.queryByRole("button", { name: "Dismiss finished commands" })).toBeNull();
  });

  it("compacts open finished work to twenty cards and reveals the rest on request", async () => {
    const user = userEvent.setup();
    const finished = Array.from({ length: 24 }, (_, index) => taskTrace({
      id: `done-${String(index).padStart(2, "0")}`,
      providerName: `Done ${index}`,
      description: `Done ${index}`,
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
    expect(screen.getByText("No background tasks")).toBeVisible();
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
    for (const toggle of screen.getAllByRole("button", { name: "View transcript for Explorer" })) {
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

describe("Background tasks stylesheets", () => {
  const css = readFileSync("src/renderer/src/components/BackgroundTasksSurface.css", "utf8");
  const shared = readFileSync("src/renderer/src/styles.css", "utf8").replaceAll("\r\n", "\n");

  it("uses semantic colour tokens only so preset and custom themes apply", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(css).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/u);
  });

  it("lifts the two-line clamp on what a task is doing only while its transcript is open", () => {
    expect(css).toMatch(/\.background-task-line \{[^}]*-webkit-line-clamp: 2;/u);
    expect(css).toMatch(/\.background-task-doing:has\(\[aria-expanded="true"\]\) \.background-task-line \{[^}]*-webkit-line-clamp: unset;/u);
  });

  it("stays plain: no shadows, uppercase labels or pill shapes", () => {
    expect(css).not.toMatch(/box-shadow|text-transform|999px/u);
  });

  it("adapts to narrow containers, reduced motion and forced colours", () => {
    expect(css).toMatch(/@container background-tasks \(max-width: 360px\)/u);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/u);
    expect(css).toMatch(/@media \(forced-colors: active\)/u);
  });

  it("reuses the timeline's thinking sweep for running work, including its motion and visibility guards", () => {
    const rulesWith = (selector: string) => shared.split("}").filter((rule) => rule.includes(selector));
    expect(rulesWith(".background-task-live").some((rule) => rule.includes(".turn-thinking-pulse") && rule.includes("animation: turn-thinking-sweep"))).toBe(true);
    const reduced = shared.slice(shared.indexOf("@media (prefers-reduced-motion: reduce) {\n  .turn-thinking-line > span"));
    expect(reduced.slice(0, reduced.indexOf("@media (forced-colors"))).toMatch(/\.background-task-live/u);
    const forced = reduced.slice(reduced.indexOf("@media (forced-colors"));
    expect(forced.slice(0, forced.indexOf("}\n}"))).toMatch(/\.background-task-live/u);
    expect(shared).toMatch(/\.app-shell\[data-document-visible="false"\] \.background-task-live/u);
    expect(css).not.toMatch(/@keyframes/u);
  });
});
