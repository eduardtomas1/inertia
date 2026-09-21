import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import { PanelLayoutControls } from "../../src/renderer/src/components/workspace-header/PanelLayoutControls";
import type { EnvironmentUsageSummary } from "../../src/renderer/src/utils/environmentSummary";

function usage(fiveHourRemaining: number): EnvironmentUsageSummary {
  return {
    providerId: "claude",
    providerLabel: "Claude",
    context: {
      quality: "current",
      remainingPercent: 74,
      valueLabel: "74%",
      accessibleLabel: "74% of context left",
      updatedAt: null,
    },
    quota: {
      freshness: "current",
      source: "selected-route",
      updatedAt: null,
      limits: [{
        id: "weekly",
        label: "Weekly",
        remainingPercent: 81,
        windowMinutes: 10_080,
        resetsAt: "2099-09-25T09:00:00.000Z",
      }, {
        id: "five-hour",
        label: "Session",
        remainingPercent: fiveHourRemaining,
        windowMinutes: 300,
        resetsAt: "2099-09-21T14:20:00.000Z",
      }],
    },
  };
}

type ControlProps = ComponentProps<typeof PanelLayoutControls>;

function controls(overrides: Partial<ControlProps> = {}): ControlProps {
  return {
    usage: usage(62),
    terminalAvailable: true,
    terminalOpen: false,
    terminalShortcutLabel: "Ctrl+J",
    rightPanelAvailable: true,
    rightPanelOpen: false,
    liveAgentCount: 0,
    onToggleTerminal: vi.fn(),
    onToggleRightPanel: vi.fn(),
    onOpenUsage: vi.fn(),
    ...overrides,
  };
}

describe("corner panel controls and header meter", () => {
  it("shows the tightest limit and explains both windows on focus", async () => {
    const props = controls();
    render(<PanelLayoutControls {...props} />);
    const meter = await screen.findByRole("button", { name: "Usage: 62% of 5-hour limit left" });
    expect(meter).toHaveTextContent("62%");
    expect(meter).not.toHaveClass("is-low");
    expect(meter.querySelectorAll(".header-usage-meter-bars > i")).toHaveLength(2);

    fireEvent.focus(meter);
    const popover = screen.getByRole("tooltip");
    expect(meter).toHaveAccessibleDescription(/Claude/u);
    expect(within(popover).getByText("5-hour limit")).toBeVisible();
    expect(within(popover).getByText("Weekly limit")).toBeVisible();
    expect(within(popover).getByText("62% left")).toBeVisible();
    expect(within(popover).getByText("81% left")).toBeVisible();
    expect(within(popover).getAllByText(/^Resets in/u)).toHaveLength(2);

    fireEvent.keyDown(meter, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.click(meter);
    expect(props.onOpenUsage).toHaveBeenCalledOnce();
  });

  it("turns the meter amber under 20% and hides it without shared quota", async () => {
    const view = render(<PanelLayoutControls {...controls({ usage: usage(19) })} />);
    const meter = await screen.findByRole("button", { name: "Usage: 19% of 5-hour limit left" });
    expect(meter).toHaveClass("is-low");

    view.rerender(<PanelLayoutControls {...controls({ usage: null })} />);
    expect(screen.queryByRole("button", { name: /^Usage:/u })).not.toBeInTheDocument();
  });

  it("toggles the terminal and right panel with pressed state and a live agent badge", () => {
    const props = controls({ terminalOpen: true, rightPanelOpen: true, liveAgentCount: 2 });
    render(<PanelLayoutControls {...props} />);
    const terminal = screen.getByRole("button", { name: "Toggle terminal" });
    expect(terminal).toHaveAttribute("aria-pressed", "true");
    expect(terminal).toHaveAttribute("title", "Toggle terminal (Ctrl+J)");
    fireEvent.click(terminal);
    expect(props.onToggleTerminal).toHaveBeenCalledOnce();

    const panel = screen.getByRole("button", { name: "Toggle right panel, 2 agents working" });
    expect(panel).toHaveAttribute("aria-pressed", "true");
    expect(panel).toHaveTextContent("2");
    fireEvent.click(panel);
    expect(props.onToggleRightPanel).toHaveBeenCalledOnce();
  });
});
