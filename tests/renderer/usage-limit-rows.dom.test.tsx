import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LimitRows, type LimitRowValue } from "../../src/renderer/src/components/usage/LimitBar";
import { UsageSurface } from "../../src/renderer/src/components/UsageSurface";
import type { EnvironmentUsageSummary } from "../../src/renderer/src/utils/environmentSummary";

const NOW = new Date("2026-11-11T10:00:00.000Z");
const at = (minutes: number): string => new Date(NOW.getTime() + minutes * 60_000).toISOString();
const limit = (id: string, label: string, remainingPercent: number, windowMinutes: number | null, resetsAt: string | null): LimitRowValue => (
  { id, label, remainingPercent, windowMinutes, resetsAt }
);
const labels = (root: HTMLElement): string[] => [...root.querySelectorAll(".limit-row-label")].map((label) => label.textContent ?? "");

function summary(limits: LimitRowValue[], providerId: EnvironmentUsageSummary["providerId"] = "codex"): EnvironmentUsageSummary {
  return {
    providerId,
    providerLabel: "Codex",
    context: { quality: "current", remainingPercent: 72, valueLabel: "72%", accessibleLabel: "Context 72% remaining", updatedAt: null },
    quota: { freshness: "current", source: "selected-route", updatedAt: NOW.toISOString(), limits: limits as EnvironmentUsageSummary["quota"]["limits"] },
  };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe("compact limit rows", () => {
  it("names each window once in the Usage surface, without repeating its length", () => {
    render(<UsageSurface usage={summary([
      limit("codex:primary", "Codex", 64, 300, at(90)),
      limit("codex:secondary", "Codex · secondary", 77, 10_080, at(2 * 1_440)),
    ])} />);
    const usage = screen.getByRole("region", { name: "Usage" });
    expect(labels(usage)).toEqual(["Session", "Weekly"]);
    expect(within(usage).getByRole("meter", { name: "Session remaining" })).toHaveAttribute("aria-valuenow", "64");
    expect(within(usage).getByRole("meter", { name: "Weekly remaining" })).toHaveAttribute("aria-valuenow", "77");
    expect(usage).not.toHaveTextContent(/5-hour|7[- ]day|Weekly\s*·?\s*Weekly|secondary/iu);
  });

  it("keeps Claude's own names and tells its weekly windows apart", () => {
    render(<UsageSurface usage={summary([
      limit("claude:five_hour", "Session", 90, 300, at(60)),
      limit("claude:seven_day", "Weekly", 84, 10_080, at(78 * 60)),
      limit("claude:seven_day_overage_included", "Weekly · Fable", 68, 10_080, at(78 * 60)),
    ], "claude")} />);
    expect(labels(screen.getByRole("region", { name: "Usage" }))).toEqual(["Session", "Weekly", "Weekly · Fable"]);
  });

  it("draws what is left, what the reset restores, the pace line and the countdown", () => {
    const view = render(<LimitRows providerId="claude" now={NOW.getTime()} limits={[limit("claude:seven_day", "Weekly", 84, 10_080, at(78 * 60))]} />);
    const meter = screen.getByRole("meter", { name: "Weekly remaining" });
    expect(meter).toHaveAttribute("data-provider", "claude");
    expect(meter).toHaveAttribute("data-compact", "true");
    expect(meter.querySelector<HTMLElement>(".limit-bar-fill")!.style.width).toBe("84%");
    expect(meter.querySelector<HTMLElement>(".limit-bar-hatch")!.style.width).toBe("16%");
    expect(meter.style.getPropertyValue("--limit-mark")).toBe("46%");
    expect(meter.querySelector(".limit-bar-mark")).not.toBeNull();
    expect(screen.getByText("84% left")).toBeVisible();
    expect(screen.getByRole("img", { name: "Under pace: headroom left for the rest of the window" })).toBeVisible();
    expect(screen.getByText("Resets in 3d 6h")).toHaveAttribute("title", expect.stringMatching(/Nov 14/u));
    expect(view.container.querySelector(".limit-row")).toHaveAttribute("data-tone", "ok");
  });

  it("leaves out the marker, the pace and the countdown when the provider reports no reset", () => {
    const view = render(<LimitRows providerId="grok" now={NOW.getTime()} limits={[limit("grok:subscription", "Weekly", 15, null, null)]} />);
    const meter = screen.getByRole("meter", { name: "Weekly remaining" });
    expect(meter.querySelector(".limit-bar-mark")).toBeNull();
    expect(meter.querySelector(".limit-bar-hatch")).toBeNull();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(view.container.querySelector(".limit-row-reset")).toBeNull();
    expect(view.container.querySelector(".limit-row")).toHaveAttribute("data-tone", "critical");
    expect(view.container.querySelector(".limit-row")).toHaveAttribute("data-low", "true");
  });

  it("shows a session as used up while the weekly limit is exhausted, like the popup does", () => {
    render(<LimitRows providerId="codex" now={NOW.getTime()} limits={[
      limit("codex:primary", "Codex", 58, 300, at(120)),
      limit("codex:secondary", "Codex · secondary", 0, 10_080, at(23 * 60 + 33)),
    ]} />);
    const session = screen.getByRole("meter", { name: "Session remaining" });
    expect(session).toHaveAttribute("aria-valuenow", "0");
    expect(session.querySelector(".limit-bar-fill")).toBeNull();
    expect(session.querySelector<HTMLElement>(".limit-bar-hatch")!.style.width).toBe("100%");
    expect(session.querySelector(".limit-bar-mark")).toBeNull();
    expect(screen.getAllByText("Resets in 23h 33m")).toHaveLength(2);
  });

  it("shows a passed reset as due, with the whole bar waiting to be restored", () => {
    const view = render(<LimitRows providerId="codex" now={NOW.getTime()} limits={[limit("codex:primary", "Codex", 12, 300, at(-1))]} />);
    const meter = screen.getByRole("meter", { name: "Session remaining" });
    expect(meter).not.toHaveAttribute("aria-valuenow");
    expect(meter).toHaveAttribute("aria-valuetext", "Reset due, usage not yet updated");
    expect(meter).toHaveAttribute("data-due", "true");
    expect(meter.querySelector<HTMLElement>(".limit-bar-hatch")!.style.width).toBe("100%");
    expect(screen.getByText("Reset")).toBeVisible();
    expect(screen.getByText("Reset due · updating")).toBeVisible();
    expect(view.container.querySelector(".limit-row")).not.toHaveAttribute("data-tone");
  });
});
