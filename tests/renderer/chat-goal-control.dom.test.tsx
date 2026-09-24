import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChatGoalControl,
  type ChatGoalControlProps,
} from "../../src/renderer/src/components/ChatGoalControl";
import type {
  AgentGoal,
  AgentWorkflowState,
} from "../../src/shared/contracts";

const conversationId = "30303030-3030-4030-8030-303030303030";
const now = "2026-08-08T10:00:00.000Z";

function goal(
  source: AgentGoal["source"],
  objective: string,
  status: AgentGoal["status"] = "active",
): AgentGoal {
  return {
    conversationId,
    source,
    providerSessionId: source === "codex-native" ? "thread-1" : null,
    objective,
    status,
    tokenBudget: null,
    tokensUsed: source === "codex-native" ? 0 : null,
    timeUsedSeconds: source === "codex-native" ? 0 : null,
    createdAt: now,
    updatedAt: now,
    synchronizedAt: source === "codex-native" ? now : null,
  };
}

function workflow(
  capability: AgentWorkflowState["goalCapability"],
  goals: AgentGoal[] = [],
  id = conversationId,
): AgentWorkflowState {
  return {
    conversationId: id,
    goals,
    goalCapability: capability,
    skills: [],
    skillsCapability: {
      kind: "unavailable",
      available: false,
      label: "Skills unavailable",
      reason: "Not part of this test.",
    },
    goalRefreshWarning: null,
    skillDiscovery: {
      truncated: false,
      warningCount: 0,
      synchronizedAt: null,
    },
    refreshedAt: now,
  };
}

function props(
  state: AgentWorkflowState | null,
  overrides: Partial<ChatGoalControlProps> = {},
): ChatGoalControlProps {
  return {
    workflow: state,
    executionStatus: "running",
    loading: false,
    busy: false,
    error: null,
    onRetry: vi.fn(async () => undefined),
    onSetGoal: vi.fn(async () => undefined),
    onClearGoal: vi.fn(async () => undefined),
    ...overrides,
  };
}

function openProps(onDismiss = vi.fn()): {
  open: true;
  onDismiss: (
    reason: "action" | "escape" | "owner-change",
  ) => void;
} {
  return { open: true, onDismiss };
}

const nativeCapability = {
  kind: "codex-native",
  available: true,
  label: "Codex native goal",
} as const;
const localCapability = {
  kind: "inertia-local",
  available: true,
  label: "Inertia local goal",
  reason: "This provider does not expose a native thread-goal API.",
} as const;

function controlAnimationFrames(): () => void {
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextId, callback);
    return nextId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  return () => act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  });
}

afterEach(() => vi.restoreAllMocks());

describe("ChatGoalControl", () => {
  it("keeps budget typing in its field when workflow data refreshes", async () => {
    const flushFrame = controlAnimationFrames();
    const user = userEvent.setup();
    const onSetGoal = vi.fn(async () => undefined);
    const disclosure = openProps();
    const view = render(<ChatGoalControl {...props(workflow(nativeCapability), { onSetGoal })} {...disclosure} />);
    const objective = screen.getByRole("textbox", { name: "Objective" });
    const budget = screen.getByRole("spinbutton", { name: "Token budget (optional)" });
    flushFrame();
    expect(objective).toHaveFocus();
    fireEvent.change(objective, { target: { value: "Ship the reliable goal flow" } });
    budget.focus();
    view.rerender(<ChatGoalControl {...props(workflow(nativeCapability), { onSetGoal })} {...disclosure} />);
    flushFrame();
    expect(budget).toHaveFocus();
    await user.keyboard("12000");
    await user.click(screen.getByRole("button", { name: "Set Codex goal" }));
    expect(onSetGoal).toHaveBeenCalledWith({ source: "codex-native", objective: "Ship the reliable goal flow", status: "active", tokenBudget: 12000 });
  });

  it.each(["budget", "outside"])("preserves explicit %s focus before the initial frame", (target) => {
    const flushFrame = controlAnimationFrames();
    render(<><button>Other control</button><ChatGoalControl {...props(workflow(nativeCapability))} {...openProps()} /></>);
    const selected = target === "budget"
      ? screen.getByRole("spinbutton", { name: "Token budget (optional)" })
      : screen.getByRole("button", { name: "Other control" });
    selected.focus();
    flushFrame();
    expect(selected).toHaveFocus();
  });

  it("adopts an initially unknown workflow owner and focuses once when it arrives", () => {
    const flushFrame = controlAnimationFrames();
    const onDismiss = vi.fn();
    const view = render(<ChatGoalControl {...props(null, { loading: true })} {...openProps(onDismiss)} />);
    flushFrame();
    expect(screen.getByRole("button", { name: "Retry" })).not.toHaveFocus();
    view.rerender(<ChatGoalControl {...props(workflow(nativeCapability))} {...openProps(onDismiss)} />);
    flushFrame();
    expect(screen.getByRole("textbox", { name: "Objective" })).toHaveFocus();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("waits for an enabled opening target without consuming the focus intent", () => {
    const flushFrame = controlAnimationFrames();
    const state = workflow(nativeCapability);
    const disclosure = openProps();
    const view = render(<ChatGoalControl {...props(state, { busy: true })} {...disclosure} />);
    const objective = screen.getByRole("textbox", { name: "Objective" });
    flushFrame();
    expect(objective).not.toHaveFocus();
    view.rerender(<ChatGoalControl {...props(state)} {...disclosure} />);
    flushFrame();
    expect(objective).toHaveFocus();
  });

  it.each(["pointer", "focus out and back"])("respects %s intent while the opening target is disabled", (intent) => {
    const flushFrame = controlAnimationFrames();
    const state = workflow(nativeCapability);
    const disclosure = openProps();
    const content = (open: boolean, busy: boolean) => <>
      <button>Opener</button><button>Other control</button>
      <ChatGoalControl {...props(state, { busy })} {...disclosure} open={open} />
    </>;
    const view = render(content(false, true));
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();
    view.rerender(content(true, true));
    flushFrame();
    if (intent === "pointer") fireEvent.pointerDown(opener);
    else {
      screen.getByRole("button", { name: "Other control" }).focus();
      opener.focus();
    }
    view.rerender(content(true, false));
    flushFrame();
    expect(opener).toHaveFocus();
  });

  it("keeps typing in the composer when the opening target becomes enabled later", () => {
    const flushFrame = controlAnimationFrames();
    const state = workflow(nativeCapability);
    const disclosure = openProps();
    const content = (open: boolean, busy: boolean) => <>
      <textarea aria-label="Composer" />
      <ChatGoalControl {...props(state, { busy })} {...disclosure} open={open} />
    </>;
    // The composer already has focus when the goal surface opens over it.
    const view = render(content(false, true));
    const composer = screen.getByRole("textbox", { name: "Composer" });
    composer.focus();
    view.rerender(content(true, true));
    flushFrame();
    fireEvent.keyDown(composer, { key: "a" });
    view.rerender(content(true, false));
    flushFrame();
    expect(composer).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Objective" })).not.toHaveFocus();
  });

  it("returns focus to the goal actions after a status action replaces the focused button", async () => {
    const user = userEvent.setup();
    const onSetGoal = vi.fn(async () => undefined);
    const disclosure = openProps();
    const active = goal("codex-native", "Ship the reliable goal flow");
    const view = render(<ChatGoalControl {...props(workflow(nativeCapability, [active]), { onSetGoal })} {...disclosure} />);
    const surface = screen.getByRole("region", { name: "Codex goal" });
    await user.click(within(surface).getByRole("button", { name: "Pause" }));
    expect(onSetGoal).toHaveBeenCalledWith({ source: "codex-native", status: "paused" });
    const paused = goal("codex-native", "Ship the reliable goal flow", "paused");
    view.rerender(<ChatGoalControl {...props(workflow(nativeCapability, [paused]), { onSetGoal })} {...disclosure} />);
    expect(within(surface).getByRole("button", { name: "Mark active" })).toHaveFocus();
  });

  it("keeps the focus restore armed while the replacement button is still disabled", async () => {
    const user = userEvent.setup();
    let settle: (() => void) | undefined;
    const onSetGoal = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));
    const disclosure = openProps();
    const active = goal("codex-native", "Ship the reliable goal flow");
    const view = render(<ChatGoalControl {...props(workflow(nativeCapability, [active]), { onSetGoal })} {...disclosure} />);
    const surface = screen.getByRole("region", { name: "Codex goal" });
    await user.click(within(surface).getByRole("button", { name: "Pause" }));
    // The goal update arrives before the mutation settles, so the new button
    // is still disabled and cannot take focus yet.
    const paused = goal("codex-native", "Ship the reliable goal flow", "paused");
    view.rerender(<ChatGoalControl {...props(workflow(nativeCapability, [paused]), { onSetGoal })} {...disclosure} />);
    const markActive = within(surface).getByRole("button", { name: "Mark active" });
    expect(markActive).toBeDisabled();
    expect(document.body).toHaveFocus();
    await act(async () => {
      settle?.();
      await Promise.resolve();
    });
    expect(markActive).toBeEnabled();
    expect(markActive).toHaveFocus();
  });

  it("does not take focus when the goal status changes without a local action", () => {
    const disclosure = openProps();
    const active = goal("codex-native", "Ship the reliable goal flow");
    const view = render(<>
      <textarea aria-label="Composer" />
      <ChatGoalControl {...props(workflow(nativeCapability, [active]))} {...disclosure} />
    </>);
    const composer = screen.getByRole("textbox", { name: "Composer" });
    composer.focus();
    const paused = goal("codex-native", "Ship the reliable goal flow", "paused");
    view.rerender(<>
      <textarea aria-label="Composer" />
      <ChatGoalControl {...props(workflow(nativeCapability, [paused]))} {...disclosure} />
    </>);
    expect(composer).toHaveFocus();
  });

  it("cancels a closed opening and rearms focus only on the next open", () => {
    const flushFrame = controlAnimationFrames();
    const state = workflow(nativeCapability);
    const disclosure = openProps();
    const view = render(<ChatGoalControl {...props(state)} {...disclosure} />);
    view.rerender(<ChatGoalControl {...props(state)} {...disclosure} open={false} />);
    flushFrame();
    view.rerender(<ChatGoalControl {...props(state)} {...disclosure} />);
    flushFrame();
    expect(screen.getByRole("textbox", { name: "Objective" })).toHaveFocus();
    view.unmount();
    flushFrame();
    expect(document.body).toHaveFocus();
  });

  it("clears drafts and preserves focus when an established owner changes", () => {
    const flushFrame = controlAnimationFrames();
    const onDismiss = vi.fn();
    const content = (id: string) => <><button>Other control</button><ChatGoalControl {...props(workflow(nativeCapability, [], id))} {...openProps(onDismiss)} /></>;
    const view = render(content(conversationId));
    fireEvent.change(screen.getByRole("textbox", { name: "Objective" }), { target: { value: "Old owner draft" } });
    const other = screen.getByRole("button", { name: "Other control" });
    other.focus();
    view.rerender(content("other-conversation"));
    flushFrame();
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("owner-change");
    expect(screen.getByRole("textbox", { name: "Objective" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Objective" })).not.toHaveFocus();
    expect(other).toHaveFocus();
  });

  it("keeps recovery-budget focus when the current goal is refreshed", () => {
    const flushFrame = controlAnimationFrames();
    const limited = goal("codex-native", "Resume safely", "budgetLimited");
    const disclosure = openProps();
    const view = render(<ChatGoalControl {...props(workflow(nativeCapability, [limited]))} {...disclosure} />);
    flushFrame();
    const budget = screen.getByRole("spinbutton", { name: "New token budget" });
    budget.focus();
    view.rerender(<ChatGoalControl {...props(workflow(nativeCapability, [{ ...limited, tokensUsed: 1 }]))} {...disclosure} />);
    flushFrame();
    expect(budget).toHaveFocus();
  });

  it("creates only the current route's explicitly local objective", async () => {
    const user = userEvent.setup();
    const onSetGoal = vi.fn(async () => undefined);
    render(
      <ChatGoalControl
        {...props(workflow(localCapability), { onSetGoal })}
        {...openProps()}
      />,
    );

    const surface = screen.getByRole("region", { name: "Local objective" });
    const objective = within(surface).getByRole("textbox", {
      name: "Objective",
    });
    await waitFor(() => expect(objective).toHaveFocus());
    expect(surface).toHaveTextContent(
      "This stays in Inertia and is never injected into provider context.",
    );
    expect(surface).toHaveTextContent(localCapability.reason);

    await user.type(objective, "Keep this pane's work independently scoped");
    await user.click(within(surface).getByRole("button", {
      name: "Save local objective",
    }));

    expect(onSetGoal).toHaveBeenCalledWith({
      source: "inertia-local",
      objective: "Keep this pane's work independently scoped",
      status: "active",
      tokenBudget: null,
    });
  });

  it("shows and mutates the native goal without promoting local tracking", async () => {
    const user = userEvent.setup();
    const native = goal("codex-native", "Ship the review-clean change");
    const local = goal("inertia-local", "Private reminder for later");
    const onSetGoal = vi.fn(async () => undefined);
    const onClearGoal = vi.fn(async () => undefined);
    const onDismiss = vi.fn();
    render(
      <ChatGoalControl
        {...props(workflow(nativeCapability, [native, local]), {
          onSetGoal,
          onClearGoal,
        })}
        {...openProps(onDismiss)}
      />,
    );

    const surface = screen.getByRole("region", { name: "Codex goal" });
    expect(within(surface).getByRole("region", { name: "Current goal" }))
      .toHaveTextContent("Ship the review-clean change");
    expect(surface).not.toHaveTextContent("Private reminder for later");
    expect(surface).toHaveTextContent(
      "One separately tracked goal remains visible in the Goal workspace tool",
    );

    await user.click(within(surface).getByRole("button", { name: "Complete" }));
    expect(onSetGoal).toHaveBeenCalledWith({
      source: "codex-native",
      status: "complete",
    });
    expect(onClearGoal).not.toHaveBeenCalled();

    await user.click(within(surface).getByRole("button", {
      name: "Clear Codex goal",
    }));
    expect(onClearGoal).toHaveBeenCalledWith("codex-native");
    expect(onDismiss).toHaveBeenCalledWith("action");
  });

  it("offers Resume when an active native goal has no attached run", async () => {
    const user = userEvent.setup();
    const onSetGoal = vi.fn(async () => undefined);
    render(
      <ChatGoalControl
        {...props(workflow(nativeCapability, [
          goal("codex-native", "Resume after restart"),
        ]), {
          executionStatus: "idle",
          onSetGoal,
        })}
        {...openProps()}
      />,
    );

    const surface = screen.getByRole("region", { name: "Codex goal" });
    expect(surface).toHaveTextContent("no Inertia run is connected");
    expect(within(surface).queryByRole("button", { name: "Pause" }))
      .not.toBeInTheDocument();
    await user.click(within(surface).getByRole("button", {
      name: "Resume goal",
    }));
    expect(onSetGoal).toHaveBeenCalledWith({
      source: "codex-native",
      status: "active",
    });
  });

  it("disables goal mutations while a run is starting", () => {
    render(
      <ChatGoalControl
        {...props(workflow(nativeCapability, [
          goal("codex-native", "Wait for startup"),
        ]), { executionStatus: "starting" })}
        {...openProps()}
      />,
    );

    const surface = screen.getByRole("region", { name: "Codex goal" });
    expect(within(surface).getByRole("button", { name: "Pause" }))
      .toBeDisabled();
    expect(within(surface).getByRole("button", { name: "Clear Codex goal" }))
      .toBeDisabled();
  });

  it("explains why a saved goal cannot resume in recovery safety mode", () => {
    render(
      <ChatGoalControl
        {...props(workflow(nativeCapability, [
          goal("codex-native", "Survive the runtime restart"),
        ]), {
          executionStatus: "idle",
          busy: true,
          error: "Changes are unavailable in recovery safety mode.",
        })}
        {...openProps()}
      />,
    );

    const surface = screen.getByRole("region", { name: "Codex goal" });
    expect(within(surface).getByRole("alert")).toHaveTextContent(
      "recovery safety mode",
    );
    expect(within(surface).getByRole("button", { name: "Resume goal" }))
      .toBeDisabled();
  });

  it("requires an explicit new or removed budget to resume a limited goal", async () => {
    const user = userEvent.setup();
    const onSetGoal = vi.fn(async () => undefined);
    const limited = {
      ...goal("codex-native", "Continue within a truthful budget", "budgetLimited"),
      tokenBudget: 2_000,
      tokensUsed: 1_500,
    };
    render(
      <ChatGoalControl
        {...props(workflow(nativeCapability, [limited]), { onSetGoal })}
        {...openProps()}
      />,
    );

    const surface = screen.getByRole("region", { name: "Codex goal" });
    expect(within(surface).queryByRole("button", { name: "Mark active" }))
      .not.toBeInTheDocument();
    const budget = within(surface).getByRole("spinbutton", {
      name: "New token budget",
    });
    const raised = within(surface).getByRole("button", {
      name: "Resume with new budget",
    });
    expect(raised).toBeDisabled();
    await user.type(budget, "1600");
    expect(raised).toBeDisabled();
    await user.clear(budget);
    await user.type(budget, "3000");
    await user.click(raised);
    expect(onSetGoal).toHaveBeenCalledWith({
      source: "codex-native",
      status: "active",
      tokenBudget: 3_000,
    });
  });

  it("reports an empty native goal when only a local objective is stored", () => {
    render(
      <ChatGoalControl
        {...props(workflow(nativeCapability, [
          goal("inertia-local", "Do not present this as provider-owned"),
        ]))}
        {...openProps()}
      />,
    );

    const surface = screen.getByRole("region", { name: "Codex goal" });
    expect(within(surface).getByRole("form", { name: "Create Codex goal" }))
      .toBeInTheDocument();
    expect(surface).not.toHaveTextContent("Do not present this as provider-owned");
    expect(surface).toHaveTextContent("One separately tracked goal");
  });

  it("submits and validates an optional native token budget", async () => {
    const user = userEvent.setup();
    const onSetGoal = vi.fn(async () => undefined);
    render(
      <ChatGoalControl
        {...props(workflow(nativeCapability), { onSetGoal })}
        {...openProps()}
      />,
    );

    const surface = screen.getByRole("region", { name: "Codex goal" });
    const objective = within(surface).getByRole("textbox", {
      name: "Objective",
    });
    const budget = within(surface).getByRole("spinbutton", {
      name: "Token budget (optional)",
    });
    const submit = within(surface).getByRole("button", {
      name: "Set Codex goal",
    });
    await user.type(objective, "Finish within the explicit budget");
    await user.type(budget, "0");
    expect(budget).toHaveAttribute("aria-invalid", "true");
    expect(submit).toBeDisabled();
    await user.clear(budget);
    await user.type(budget, "12000");
    expect(budget).toHaveAttribute("aria-invalid", "false");
    await user.click(submit);

    expect(onSetGoal).toHaveBeenCalledWith({
      source: "codex-native",
      objective: "Finish within the explicit budget",
      status: "active",
      tokenBudget: 12_000,
    });
  });

  it("labels a local budget as an unenforced token target", () => {
    render(
      <ChatGoalControl
        {...props(workflow(localCapability, [{
          ...goal("inertia-local", "Track locally"),
          tokenBudget: 5_000,
        }]))}
        {...openProps()}
      />,
    );

    expect(screen.getByText("Local token target: 5,000", { exact: false }))
      .toHaveTextContent("does not measure or enforce provider usage");
  });

  it("dismisses on Escape and keeps split actions with their pane owner", async () => {
    const primarySetGoal = vi.fn(async () => undefined);
    const secondarySetGoal = vi.fn(async () => undefined);
    const dismissPrimary = vi.fn();
    const dismissSecondary = vi.fn();
    render(
      <>
        <section aria-label="Primary chat">
          <ChatGoalControl
            {...props(workflow(nativeCapability, [
              goal("codex-native", "Primary objective"),
            ], "primary"), { onSetGoal: primarySetGoal })}
            {...openProps(dismissPrimary)}
          />
        </section>
        <section aria-label="Second chat">
          <ChatGoalControl
            {...props(workflow(localCapability, [
              {
                ...goal("inertia-local", "Secondary objective"),
                conversationId: "secondary",
              },
            ], "secondary"), { onSetGoal: secondarySetGoal })}
            open={false}
            onDismiss={dismissSecondary}
          />
        </section>
      </>,
    );

    const primary = screen.getByRole("region", { name: "Primary chat" });
    fireEvent.click(within(primary).getByRole("button", { name: "Pause" }));

    await waitFor(() => expect(primarySetGoal).toHaveBeenCalledWith({
      source: "codex-native",
      status: "paused",
    }));
    expect(secondarySetGoal).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(dismissPrimary).toHaveBeenCalledWith("escape"));
    expect(dismissSecondary).not.toHaveBeenCalled();
  });

  it("stays integrated while the user interacts elsewhere in the chat", () => {
    const onDismiss = vi.fn();
    render(
      <>
        <ChatGoalControl
          {...props(workflow(nativeCapability))}
          {...openProps(onDismiss)}
        />
        <button type="button">Another workspace control</button>
      </>,
    );

    fireEvent.pointerDown(screen.getByRole("button", {
      name: "Another workspace control",
    }));

    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Codex goal" }))
      .toBeInTheDocument();
  });

  it("does not dismiss a closed surface when background ownership refreshes", () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <ChatGoalControl
        {...props(workflow(nativeCapability, [], "primary"))}
        open={false}
        onDismiss={onDismiss}
      />,
    );

    rerender(
      <ChatGoalControl
        {...props(workflow(localCapability, [], "secondary"))}
        open={false}
        onDismiss={onDismiss}
      />,
    );

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("keeps the retry path accessible when workflow loading fails", async () => {
    const onRetry = vi.fn(async () => undefined);
    render(
      <ChatGoalControl
        {...props(null, {
          error: "The workflow request failed.",
          onRetry,
        })}
        {...openProps()}
      />,
    );

    const surface = screen.getByRole("region", { name: "Goal" });
    expect(within(surface).getByRole("alert"))
      .toHaveTextContent("The workflow request failed.");
    fireEvent.click(within(surface).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
  });
});
