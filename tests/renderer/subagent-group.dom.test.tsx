import { readFileSync } from "node:fs";

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BackgroundTasksSurface } from "../../src/renderer/src/components/BackgroundTasksSurface";
import { SubagentGroup } from "../../src/renderer/src/components/response-timeline/SubagentGroup";
import {
  requestBackgroundTaskReveal,
  takeBackgroundTaskReveal,
} from "../../src/renderer/src/utils/backgroundTaskReveal";
import { declarationsFor, parseCssRules } from "./css-rules";
import { taskTrace, taskTurn } from "./background-task-fixtures";

const css = readFileSync("src/renderer/src/components/response-timeline/SubagentGroup.css", "utf8")
  .replace(/\r\n?/gu, "\n");
const rules = parseCssRules(css);
const line = { conversationId: "conversation-1", turnId: "turn-1" };
const NOW = Date.parse("2030-01-01T00:01:00.000Z");

const mixed = [
  taskTrace({ id: "a", providerId: "codex", providerName: "Sidebar", progress: "Reading the sidebar rows" }),
  taskTrace({ id: "b", providerName: "Composer", status: "completed", result: "Composer findings ready.", durationMs: 40_000 }),
  taskTrace({ id: "c", providerName: null, providerRole: "general_purpose", status: "completed", result: null, durationMs: 20_000 }),
];

const settled = [
  taskTrace({ id: "done", providerName: "Contract reader", status: "completed", result: "Contracts hold.", durationMs: 30_000 }),
  taskTrace({ id: "broken", providerName: "Migration verifier", status: "failed", result: "The migration check stopped early.", createdAt: "2030-01-01T00:00:05.000Z", updatedAt: "2030-01-01T00:00:50.000Z" }),
];

function groupButton(): HTMLElement {
  return screen.getByRole("button", { name: /^\d+ subagents?, /u });
}

afterEach(() => {
  takeBackgroundTaskReveal("conversation-1");
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("subagent group row", () => {
  it("renders nothing for a turn without subagents", () => {
    const view = render(<SubagentGroup {...line} subagents={[]} onOpenSurface={vi.fn()} />);
    expect(view.container).toBeEmptyDOMElement();
  });

  it("says how many subagents there are and their states in words, with the working count in its colour", () => {
    render(<SubagentGroup {...line} subagents={mixed} onOpenSurface={vi.fn()} />);
    const button = screen.getByRole("button", { name: "3 subagents, 1 working · 2 done" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button.querySelector(".subagent-group-title")).toHaveTextContent(/^3 subagents$/u);
    const status = button.querySelector(".subagent-group-status")!;
    expect(status).toHaveTextContent(/^1 working · 2 done$/u);
    expect(within(status as HTMLElement).getByText("1 working")).toHaveAttribute("data-tone", "working");
    expect(declarationsFor(rules, '.subagent-group-status > [data-tone="working"]').get("color")).toBe("var(--status-working)");
    expect(declarationsFor(rules, ".subagent-group-title").get("font-weight")).toBe("500");
    expect(declarationsFor(rules, ".subagent-group-agent-detail").get("font-size")).toBe("var(--text-xs)");
  });

  it("names failures in words and in the failed colour", () => {
    render(<SubagentGroup {...line} subagents={[...mixed, taskTrace({ id: "d", status: "failed" })]} onOpenSurface={vi.fn()} />);
    const button = screen.getByRole("button", { name: "4 subagents, 1 working · 2 done · 1 failed" });
    const failed = button.querySelector('[data-tone="failed"]')!;
    expect(failed).toHaveTextContent(/^· 1 failed$/u);
    expect(declarationsFor(rules, '.subagent-group-status > :is([data-tone="failed"], [data-tone="review"])').get("color")).toBe("var(--status-failed)");
    expect(button.querySelectorAll('[data-tone="working"]')).toHaveLength(1);
  });

  it("says an unknown outcome needs review, in its own word and the failed colour", async () => {
    const user = userEvent.setup();
    render(<SubagentGroup {...line} subagents={[
      taskTrace({ id: "done", providerName: "Reader", status: "completed" }),
      taskTrace({ id: "unknown", providerName: "Checker", status: "unknown", isLive: false }),
    ]} onOpenSurface={vi.fn()} />);
    const button = screen.getByRole("button", { name: "2 subagents, 1 done · 1 needs review" });
    expect(button.querySelector('[data-tone="review"]')).toHaveTextContent(/^· 1 needs review$/u);
    expect(button.closest(".subagent-group")).not.toHaveClass("is-idle");
    await user.click(button);
    const row = screen.getByRole("button", { name: "Open Checker in Background tasks, Needs review" });
    expect(row).toHaveAttribute("data-subagent-tone", "review");
    expect(declarationsFor(rules, '[data-subagent-tone="review"]').get("--subagent-tone")).toBe("var(--status-failed)");
  });

  it("counts waiting and queued agents in their own words, not as working", async () => {
    const user = userEvent.setup();
    render(<SubagentGroup {...line} subagents={[
      taskTrace({ id: "w", providerName: "Waiter", status: "waiting" }),
      taskTrace({ id: "q", providerName: "Queuer", status: "queued" }),
      taskTrace({ id: "d", providerName: "Doer", status: "completed", durationMs: 4_000 }),
    ]} onOpenSurface={vi.fn()} />);
    const button = screen.getByRole("button", { name: "3 subagents, 1 waiting · 1 queued · 1 done" });
    expect(button.querySelector('[data-tone="working"]')).toBeNull();
    const group = button.closest(".subagent-group")!;
    expect(group).toHaveAttribute("data-subagent-group", "settled");
    expect(group).not.toHaveClass("is-idle");
    await user.click(button);
    expect(screen.getByRole("button", { name: "Open Waiter in Background tasks, Waiting" }))
      .toHaveAttribute("data-subagent-tone", "waiting");
    expect(screen.getByRole("button", { name: "Open Queuer in Background tasks, Queued" }))
      .toHaveAttribute("data-subagent-tone", "queued");
    expect(declarationsFor(rules, '[data-subagent-tone="waiting"]').get("--subagent-tone")).toBe("var(--status-input)");
  });

  it("does not keep the group timer running for an agent that is only waiting", () => {
    vi.useFakeTimers({ now: NOW + 600_000 });
    const view = render(<SubagentGroup {...line} subagents={[
      taskTrace({ id: "w", status: "waiting", createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:20.000Z" }),
    ]} onOpenSurface={vi.fn()} />);
    const elapsed = view.container.querySelector(".subagent-group-elapsed")!;
    expect(elapsed).toHaveTextContent(/^20s$/u);
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(elapsed).toHaveTextContent(/^20s$/u);
  });

  it("stacks up to three provider avatars, first on top, and counts the rest in a disc", () => {
    const traces = Array.from({ length: 5 }, (_, index) => taskTrace({
      id: `t${index}`,
      providerId: index === 0 ? "codex" : "claude",
      status: "completed",
    }));
    render(<SubagentGroup {...line} subagents={traces} onOpenSurface={vi.fn()} />);
    const avatars = groupButton().querySelector(".subagent-group-avatars")!;
    expect(avatars).toHaveAttribute("aria-hidden", "true");
    const discs = [...avatars.children];
    expect(discs).toHaveLength(4);
    expect(discs[0]!.querySelector("[data-provider-id]")).toHaveAttribute("data-provider-id", "codex");
    expect(discs[3]).toHaveClass("is-overflow");
    expect(discs[3]).toHaveTextContent(/^\+2$/u);
    expect(declarationsFor(rules, ".subagent-group-avatars > :nth-child(1)").get("z-index")).toBe("3");
    expect(declarationsFor(rules, ".subagent-group-avatars > :nth-child(3)").get("z-index")).toBe("1");
    expect(declarationsFor(rules, ".subagent-group-avatars > .subagent-avatar + .subagent-avatar").get("margin-left")).toBe("-4px");
    const avatar = declarationsFor(rules, ".subagent-avatar");
    expect(avatar.get("width")).toBe("20px");
    expect(avatar.get("background")).toBe("var(--surface-raised)");
    expect(avatar.get("border")).toBe("1px solid var(--line-soft)");
  });

  it("shows no overflow disc for three or fewer subagents", () => {
    render(<SubagentGroup {...line} subagents={mixed} onOpenSurface={vi.fn()} />);
    expect(groupButton().querySelectorAll(".subagent-avatar")).toHaveLength(3);
    expect(groupButton().querySelector(".is-overflow")).toBeNull();
  });

  it("writes the live group elapsed to the DOM each second without re-rendering React", () => {
    vi.useFakeTimers({ now: NOW });
    const renders = vi.fn();
    const view = render(
      <Profiler id="group" onRender={renders}>
        <SubagentGroup {...line} subagents={mixed} onOpenSurface={vi.fn()} />
      </Profiler>,
    );
    const elapsed = view.container.querySelector(".subagent-group-elapsed")!;
    expect(elapsed).toHaveTextContent("1m");
    const committed = renders.mock.calls.length;
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(elapsed).toHaveTextContent("1m 5s");
    expect(renders).toHaveBeenCalledTimes(committed);
    expect(declarationsFor(rules, ".subagent-group-elapsed").get("font-variant-numeric")).toBe("tabular-nums");
  });

  it("freezes a settled group's elapsed from the first start to the last end", () => {
    vi.useFakeTimers({ now: NOW + 600_000 });
    const view = render(<SubagentGroup {...line} subagents={settled} onOpenSurface={vi.fn()} />);
    const elapsed = view.container.querySelector(".subagent-group-elapsed")!;
    expect(elapsed).toHaveTextContent(/^50s$/u);
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(elapsed).toHaveTextContent(/^50s$/u);
  });

  it("dims a collapsed group only when every agent is done, and restores it on hover, focus, touch or when open", async () => {
    const user = userEvent.setup();
    const allDone = [settled[0]!, taskTrace({ id: "done-2", providerName: "Docs checker", status: "completed", durationMs: 10_000 })];
    const view = render(<SubagentGroup {...line} subagents={settled} onOpenSurface={vi.fn()} />);
    expect(view.container.querySelector(".subagent-group")).not.toHaveClass("is-idle");
    for (const other of [
      taskTrace({ id: "o", status: "cancelled" }),
      taskTrace({ id: "o", status: "unknown", isLive: false }),
      taskTrace({ id: "o", status: "waiting" }),
      taskTrace({ id: "o", status: "queued" }),
    ]) {
      view.rerender(<SubagentGroup {...line} subagents={[settled[0]!, other]} onOpenSurface={vi.fn()} />);
      expect(view.container.querySelector(".subagent-group"), other.status).not.toHaveClass("is-idle");
    }
    view.rerender(<SubagentGroup {...line} subagents={allDone} onOpenSurface={vi.fn()} />);
    const group = view.container.querySelector(".subagent-group")!;
    expect(group).toHaveClass("is-idle");
    expect(group).toHaveAttribute("data-subagent-group", "settled");
    const dimmed = '.subagent-group.is-idle > .subagent-group-row[aria-expanded="false"]';
    expect(declarationsFor(rules, dimmed).get("opacity")).toBe("var(--settled-dim)");
    expect(declarationsFor(rules, `${dimmed}:is(:hover, :focus-visible)`).get("opacity")).toBe("1");
    expect(css).toMatch(/@media \(pointer: coarse\) \{\s*\.subagent-group\.is-idle > \.subagent-group-row\[aria-expanded="false"\] \{\s*opacity: 1;/u);
    expect(css).not.toMatch(/opacity: 0\.\d/u);
    await user.click(groupButton());
    expect(groupButton()).toHaveAttribute("aria-expanded", "true");
    view.rerender(<SubagentGroup {...line} subagents={mixed} onOpenSurface={vi.fn()} />);
    expect(view.container.querySelector(".subagent-group")).not.toHaveClass("is-idle");
    expect(view.container.querySelector(".subagent-group")).toHaveAttribute("data-subagent-group", "live");
  });

  it("expands and collapses its panel by mouse, wired to the row, and keeps the choice per turn", async () => {
    const user = userEvent.setup();
    const onBeforeToggle = vi.fn();
    const onAfterToggle = vi.fn();
    const view = render(<SubagentGroup {...line} subagents={mixed} onOpenSurface={vi.fn()} onBeforeToggle={onBeforeToggle} onAfterToggle={onAfterToggle} />);
    const button = groupButton();
    const panel = document.getElementById(button.getAttribute("aria-controls")!)!;
    expect(panel).toHaveClass("subagent-group-panel");
    expect(panel).not.toBeVisible();
    expect(within(panel).queryByRole("list")).toBeNull();
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(panel).toBeVisible();
    expect(within(panel).getAllByRole("listitem")).toHaveLength(3);
    expect(onBeforeToggle).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(onAfterToggle).toHaveBeenCalledOnce());
    view.unmount();
    render(<SubagentGroup {...line} subagents={mixed} onOpenSurface={vi.fn()} />);
    expect(groupButton()).toHaveAttribute("aria-expanded", "true");
    await user.click(groupButton());
    expect(groupButton()).toHaveAttribute("aria-expanded", "false");
    expect(declarationsFor(rules, '.subagent-group-row[aria-expanded="true"] .subagent-group-chevron').get("transform")).toBe("rotate(90deg)");
    expect(declarationsFor(rules, ".subagent-group-chevron").get("transition")).toBe("transform var(--dur) var(--ease)");
  });

  it("toggles from the keyboard and reaches each agent row as a button", async () => {
    const user = userEvent.setup();
    render(<SubagentGroup {...line} subagents={mixed} onOpenSurface={vi.fn()} />);
    groupButton().focus();
    await user.keyboard("{Enter}");
    expect(groupButton()).toHaveAttribute("aria-expanded", "true");
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open Sidebar in Background tasks, Working" }));
    await user.tab({ shift: true });
    await user.keyboard(" ");
    expect(groupButton()).toHaveAttribute("aria-expanded", "false");
  });

  it("lists each agent with its avatar, status dot and word, name, one-line detail and elapsed", async () => {
    vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SubagentGroup {...line} subagents={[...mixed, taskTrace({ id: "d", providerName: "Diff", status: "failed", result: "Exited with code 1." })]} onOpenSurface={vi.fn()} />);
    await user.click(groupButton());
    const sidebar = screen.getByRole("button", { name: "Open Sidebar in Background tasks, Working" });
    expect(sidebar).toHaveAttribute("data-subagent-tone", "working");
    expect(sidebar).toHaveAccessibleDescription("Reading the sidebar rows");
    expect(sidebar.querySelector(".subagent-avatar-dot")).toHaveAttribute("aria-hidden", "true");
    expect(sidebar.querySelector(".visually-hidden")).toHaveTextContent(/^Working$/u);
    expect(sidebar.querySelector(".subagent-group-agent-name")).toHaveTextContent(/^Sidebar$/u);
    expect(sidebar.querySelector(".subagent-elapsed")).toHaveTextContent(/^1m$/u);
    const composer = screen.getByRole("button", { name: "Open Composer in Background tasks, Done" });
    expect(composer).toHaveAttribute("data-subagent-tone", "done");
    expect(composer).toHaveAccessibleDescription("Composer findings ready.");
    expect(composer.querySelector(".subagent-elapsed")).toHaveTextContent(/^40s$/u);
    const role = screen.getByRole("button", { name: "Open General purpose in Background tasks, Done" });
    expect(role).toHaveAccessibleDescription("Inspect the provider lifecycle.");
    const diff = screen.getByRole("button", { name: "Open Diff in Background tasks, Failed" });
    expect(diff).toHaveAttribute("data-subagent-tone", "failed");
    expect(diff.querySelector(".visually-hidden")).toHaveTextContent(/^Failed$/u);
    expect(diff.querySelector(".subagent-group-agent-chevron")).not.toBeNull();
    for (const [tone, colour] of [["working", "--status-working"], ["done", "--status-completed"], ["failed", "--status-failed"]]) {
      expect(declarationsFor(rules, `[data-subagent-tone="${tone}"]`).get("--subagent-tone")).toBe(`var(${colour})`);
    }
    expect(declarationsFor(rules, ".subagent-avatar-dot").get("width")).toBe("8px");
    expect(declarationsFor(rules, ".subagent-group-agent").get("min-height")).toBe("28px");
    expect(declarationsFor(rules, ".subagent-group-panel").get("background")).toBe("var(--fill)");
  });

  it("opens the agent's card in Background tasks with its trace id", async () => {
    const user = userEvent.setup();
    const onOpenSurface = vi.fn();
    render(<SubagentGroup {...line} subagents={mixed} onOpenSurface={onOpenSurface} />);
    await user.click(groupButton());
    await user.click(screen.getByRole("button", { name: "Open Composer in Background tasks, Done" }));
    expect(onOpenSurface).toHaveBeenCalledWith("agents");
    expect(takeBackgroundTaskReveal("conversation-1")).toEqual({ ...line, traceId: "b" });
  });

  it("lists agents as plain rows when nothing can open the panel", async () => {
    const user = userEvent.setup();
    render(<SubagentGroup {...line} subagents={settled} />);
    await user.click(groupButton());
    const list = screen.getByRole("list", { name: "Subagents" });
    expect(within(list).queryByRole("button")).toBeNull();
    expect(within(list).getByText("Migration verifier")).toBeVisible();
    expect(within(list).getByText("Failed")).toHaveClass("visually-hidden");
    expect(list.querySelector(".subagent-group-agent-chevron")).toBeNull();
  });

  it("opens the finished card's transcript in the panel, scrolls to it and focuses it", async () => {
    const user = userEvent.setup();
    const scrolled: Element[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    const traces = [
      taskTrace({ id: "other", turnId: "turn-0", providerName: "Earlier helper", status: "completed" }),
      ...settled,
    ];
    render(
      <>
        <SubagentGroup {...line} subagents={settled} onOpenSurface={vi.fn()} />
        <BackgroundTasksSurface
          runtimeStatus="online"
          subagents={traces}
          turns={[taskTurn({ id: "turn-0", status: "completed" }), taskTurn({ status: "completed" })]}
          runs={[]}
          conversationId="conversation-1"
          now={NOW}
        />
      </>,
    );
    const finished = screen.getByRole("button", { name: /^Finished 3/u });
    expect(finished).toHaveAttribute("aria-expanded", "false");
    await user.click(groupButton());
    await user.click(screen.getByRole("button", { name: "Open Migration verifier in Background tasks, Failed" }));
    expect(finished).toHaveAttribute("aria-expanded", "true");
    const toggle = screen.getByRole("button", { name: "View transcript for Migration verifier" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(toggle);
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]).toHaveAttribute("data-focus-row", "agent:broken");
    expect(screen.getByRole("button", { name: "View transcript for Contract reader" })).toHaveAttribute("aria-expanded", "false");
  });

  it("reveals an agent requested before the panel mounted, once", async () => {
    const user = userEvent.setup();
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => undefined);
    render(<SubagentGroup {...line} subagents={settled} onOpenSurface={vi.fn()} />);
    await user.click(groupButton());
    const row = screen.getByRole("button", { name: "Open Contract reader in Background tasks, Done" });
    await user.click(row);
    const props = {
      runtimeStatus: "online" as const,
      subagents: settled,
      turns: [taskTurn({ status: "completed" })],
      runs: [],
      conversationId: "conversation-1",
      now: NOW,
    };
    const first = render(<BackgroundTasksSurface {...props} />);
    expect(screen.getByRole("button", { name: "View transcript for Contract reader" })).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "View transcript for Contract reader" }));
    first.unmount();
    render(<BackgroundTasksSurface {...props} />);
    expect(screen.getByRole("button", { name: /^Finished 2/u })).toHaveAttribute("aria-expanded", "false");
  });

  it("leaves focus where the person moved it while the panel was opening", () => {
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => undefined);
    const elsewhere = document.createElement("input");
    elsewhere.setAttribute("aria-label", "Elsewhere");
    document.body.append(elsewhere);
    elsewhere.focus();
    requestBackgroundTaskReveal({ ...line, traceId: "done" });
    render(
      <BackgroundTasksSurface
        runtimeStatus="online"
        subagents={settled}
        turns={[taskTurn({ status: "completed" })]}
        runs={[]}
        conversationId="conversation-1"
        now={NOW}
      />,
    );
    expect(screen.getByRole("button", { name: "View transcript for Contract reader" })).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(elsewhere);
  });

  it("turns off its transitions for reduced motion", () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{\s*\.subagent-group-row,\s*\.subagent-group-chevron \{\s*transition: none;/u;
    expect(css).toMatch(reduced);
    expect(css).not.toMatch(/\b\d+(?:\.\d+)?m?s\b/u);
  });
});
