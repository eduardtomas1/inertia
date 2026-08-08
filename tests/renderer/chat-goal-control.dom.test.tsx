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
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "Add local objective",
    });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Local objective" });
    const objective = within(dialog).getByRole("textbox", {
      name: "Objective",
    });
    await waitFor(() => expect(objective).toHaveFocus());
    expect(dialog).toHaveTextContent(
      "This stays in Inertia and is never injected into provider context.",
    );
    expect(dialog).toHaveTextContent(localCapability.reason);

    await user.type(objective, "Keep this pane's work independently scoped");
    await user.click(within(dialog).getByRole("button", {
      name: "Save local objective",
    }));

    expect(onSetGoal).toHaveBeenCalledWith({
      source: "inertia-local",
      objective: "Keep this pane's work independently scoped",
      status: "active",
      tokenBudget: null,
    });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("shows and mutates the native goal without promoting local tracking", async () => {
    const user = userEvent.setup();
    const native = goal("codex-native", "Ship the review-clean change");
    const local = goal("inertia-local", "Private reminder for later");
    const onSetGoal = vi.fn(async () => undefined);
    const onClearGoal = vi.fn(async () => undefined);
    render(
      <ChatGoalControl
        {...props(workflow(nativeCapability, [native, local]), {
          onSetGoal,
          onClearGoal,
        })}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "Codex goal, active: Ship the review-clean change",
    });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Codex goal" });
    expect(within(dialog).getByRole("region", { name: "Current goal" }))
      .toHaveTextContent("Ship the review-clean change");
    expect(dialog).not.toHaveTextContent("Private reminder for later");
    expect(dialog).toHaveTextContent(
      "One separately tracked goal remains visible in the Goal workspace tool",
    );

    await user.click(within(dialog).getByRole("button", { name: "Complete" }));
    expect(onSetGoal).toHaveBeenCalledWith({
      source: "codex-native",
      status: "complete",
    });
    expect(onClearGoal).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", {
      name: "Clear Codex goal",
    }));
    expect(onClearGoal).toHaveBeenCalledWith("codex-native");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("reports an empty native goal when only a local objective is stored", () => {
    render(
      <ChatGoalControl
        {...props(workflow(nativeCapability, [
          goal("inertia-local", "Do not present this as provider-owned"),
        ]))}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Set Codex goal" }));
    const dialog = screen.getByRole("dialog", { name: "Codex goal" });
    expect(within(dialog).getByRole("form", { name: "Create Codex goal" }))
      .toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("Do not present this as provider-owned");
    expect(dialog).toHaveTextContent("One separately tracked goal");
  });

  it("restores focus on Escape and keeps split actions with their pane owner", async () => {
    const primarySetGoal = vi.fn(async () => undefined);
    const secondarySetGoal = vi.fn(async () => undefined);
    render(
      <>
        <section aria-label="Primary chat">
          <ChatGoalControl
            {...props(workflow(nativeCapability, [
              goal("codex-native", "Primary objective"),
            ], "primary"), { onSetGoal: primarySetGoal })}
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
          />
        </section>
      </>,
    );

    const primary = screen.getByRole("region", { name: "Primary chat" });
    const trigger = within(primary).getByRole("button", {
      name: "Codex goal, active: Primary objective",
    });
    const secondaryTrigger = within(screen.getByRole("region", {
      name: "Second chat",
    })).getByRole("button", {
      name: "Local objective, active: Secondary objective",
    });
    expect(trigger).toHaveAttribute("aria-controls");
    expect(secondaryTrigger).toHaveAttribute("aria-controls");
    expect(trigger.getAttribute("aria-controls"))
      .not.toBe(secondaryTrigger.getAttribute("aria-controls"));
    fireEvent.click(trigger);
    expect(document.getElementById(trigger.getAttribute("aria-controls")!))
      .toBe(screen.getByRole("dialog", { name: "Codex goal" }));
    fireEvent.click(within(primary).getByRole("button", { name: "Pause" }));

    await waitFor(() => expect(primarySetGoal).toHaveBeenCalledWith({
      source: "codex-native",
      status: "paused",
    }));
    expect(secondarySetGoal).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: "Codex goal" }))
      .not.toBeInTheDocument();
  });

  it("keeps the retry path accessible when workflow loading fails", async () => {
    const onRetry = vi.fn(async () => undefined);
    render(
      <ChatGoalControl
        {...props(null, {
          error: "The workflow request failed.",
          onRetry,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Goal unavailable" }));
    const dialog = screen.getByRole("dialog", { name: "Goal" });
    expect(within(dialog).getByRole("alert"))
      .toHaveTextContent("The workflow request failed.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
  });
});
