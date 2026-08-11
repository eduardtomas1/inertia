import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

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

describe("ChatGoalControl", () => {
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
