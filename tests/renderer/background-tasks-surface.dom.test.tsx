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
  return screen.getByText(title, { selector: ".background-task-title" }).closest("li")!;
}

async function openTranscript(title: string): Promise<HTMLElement> {
  const toggle = screen.getByRole("button", { name: `View transcript for ${title}` });
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
    const explorer = card("Explorer");
    expect(explorer).toHaveTextContent("Agent");
    expect(within(explorer).getByText("1m")).toBeVisible();
    expect(within(explorer).getByText("gpt-5.3-codex")).toBeVisible();
    expect(explorer).toHaveTextContent("128.4K tokens");
    expect(explorer).toHaveTextContent("14 tool uses");
    expect(within(explorer).getByText("Running rg subagent")).toBeVisible();
    expect(screen.getByText("Explorer", { selector: ".background-task-title" }).closest("button")).toBeNull();
    expect(within(explorer).getAllByRole("button").map((button) => button.getAttribute("aria-label")))
      .toEqual(["View transcript for Explorer"]);
  });

  it("keeps the transcript collapsed until asked and wires it to the card", async () => {
    render(surface());
    const toggle = screen.getByRole("button", { name: "View transcript for Explorer" });
    expect(toggle).toHaveTextContent("View transcript");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).not.toHaveAttribute("aria-controls");
    expect(card("Explorer").querySelector(".background-task-transcript")).toBeNull();
    const transcript = await openTranscript("Explorer");
    expect(card("Explorer")).toContainElement(transcript);
  });

  it("reads like a short transcript: task, progress, one meta line and quiet links", async () => {
    render(surface({ onFollowUpSubagent: vi.fn(), canFollowUpSubagent: () => true }));
    const transcript = await openTranscript("Explorer");
    expect(paragraphs(transcript)).toEqual([
      "Inspect the provider lifecycle.",
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
    const transcript = await openTranscript("Reviewer");
    expect(paragraphs(transcript)).toEqual([
      "No regressions found in the adapter.",
      "Inspect the provider lifecycle.",
    ]);
    expect(within(card("Reviewer")).getAllByText("No regressions found in the adapter.")).toHaveLength(1);
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
    render(surface({ subagents: [{ ...codexTask, description: "A long task ".repeat(80) }] }));
    const transcript = await openTranscript("Explorer");
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
    const child = card("Fixture writer");
    expect(child).toHaveTextContent("Agent · from Explorer");
    expect(child.closest("ol")).toBe(card("Explorer").closest("ol"));
  });

  it("collapses finished work into one row that counts failures in words", async () => {
    render(surface());
    const toggle = screen.getByRole("button", { name: "Finished 3 · 1 failed" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const finished = await openFinished();
    expect(toggle).toHaveAttribute("aria-controls", finished.id);
    expect(within(finished).getAllByRole("listitem").map((item) => item.dataset.focusRow))
      .toEqual(["agent:claude-failed", "agent:cursor-task", "agent:claude-reviewer"]);
    const failed = card("Build verifier");
    expect(within(failed).getByText("Failed")).toHaveClass("background-task-danger");
    expect(failed).toHaveTextContent("Agent · Failed");
  });

  it("animates the line of running work only, with the timeline's thinking sweep", () => {
    const waiting = taskTrace({
      id: "waiting",
      providerName: "Schema checker",
      status: "waiting",
      activity: "Edit tests/fixture.ts",
      progress: "Waiting for review",
    });
    render(surface({ subagents: [codexTask, waiting, claudeTask] }));
    expect(within(card("Explorer")).getByText("Running rg subagent")).toHaveClass("background-task-live");
    const waitingCard = card("Schema checker");
    expect(waitingCard).toHaveTextContent("Agent · Waiting");
    expect(waitingCard).not.toHaveTextContent("Edit tests/fixture.ts");
    expect(within(waitingCard).getByText("Waiting for review")).not.toHaveClass("background-task-live");
    expect(screen.getByText("Explorer", { selector: ".background-task-title" })).not.toHaveClass("background-task-live");
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
  });

  it("wires View turn, Guide parent and Stop without opening or closing the transcript", async () => {
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
    await openTranscript("Explorer");
    await user.click(screen.getByRole("button", { name: "View turn for Explorer" }));
    expect(onOpenSubagent).toHaveBeenCalledWith(codexTask);
    expect(screen.getByRole("button", { name: "View transcript for Explorer" })).toHaveAttribute("aria-expanded", "true");
    await openTranscript("Claude helper");
    await user.click(screen.getByRole("button", { name: "Guide parent about Claude helper" }));
    expect(onFollowUpSubagent).toHaveBeenCalledWith(helper);
    await user.click(screen.getByRole("button", { name: "Stop Claude helper" }));
    expect(onStopSubagent).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "View transcript for Claude helper" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Stopping Claude helper" })).toBeDisabled();
    resolveStop();
    expect(await screen.findByRole("button", { name: "Stop Claude helper" })).toBeEnabled();
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
