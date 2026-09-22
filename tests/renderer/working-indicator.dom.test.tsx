import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentActivity, SubagentTrace } from "../../src/shared/contracts/agent";
import { DEFAULT_WORKING_INDICATOR, type WorkingIndicatorSettings as Settings } from "../../src/shared/working-indicator";
import { AgentPixelGrid } from "../../src/renderer/src/components/AgentPixelGrid";
import { SubagentStatusMark } from "../../src/renderer/src/components/SubagentStatusMark";
import { ActivityRow, ReasoningSummary } from "../../src/renderer/src/components/response-timeline/activity";
import { AgentPixelLoader } from "../../src/renderer/src/components/response-timeline/layers";
import { WorkStatusCue } from "../../src/renderer/src/components/sidebar/WorkStatusCue";
import { WorkingIndicatorProvider } from "../../src/renderer/src/components/working-indicator/WorkingIndicatorContext";
import { WorkingIndicatorSettings } from "../../src/renderer/src/components/working-indicator/WorkingIndicatorSettings";
import { usePublishLiveAgentPhase } from "../../src/renderer/src/components/working-indicator/liveAgentPhases";
import { sharedOrbLoop } from "../../src/renderer/src/components/working-indicator/orbEnvironment";
import type { ActiveAgentPhase } from "../../src/renderer/src/utils/response-timeline/active-state";

const ALL_PHASES: readonly ActiveAgentPhase[] = [
  "compacting", "queued", "starting", "thinking", "searching", "coding", "command", "tool",
  "responding", "working", "delegated", "retrying", "cancelling",
  "waiting-for-approval", "waiting-for-input",
];

const automatic: Settings = { ...DEFAULT_WORKING_INDICATOR, style: "automatic" };

function runningActivity(kind: AgentActivity["kind"], title: string): AgentActivity {
  return {
    id: `${kind}-${title}`,
    conversationId: "conversation-1",
    runId: "run-1",
    turnId: "turn-1",
    kind,
    title,
    detail: null,
    status: "running",
    createdAt: "2026-09-01T10:00:00.000Z",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("working indicator placements", () => {
  it("keeps the Classic grid and compaction icon byte-identical", () => {
    const classic = render(<AgentPixelLoader animated phase="thinking" conversationId="c1" />);
    const direct = render(<AgentPixelGrid animated phase="thinking" />);
    expect(classic.container.innerHTML).toBe(direct.container.innerHTML);
    const compacting = render(<AgentPixelLoader animated phase="compacting" conversationId="c1" />);
    expect(compacting.container.querySelector(".context-compaction-icon")).not.toBeNull();
    expect(compacting.container.querySelector(".working-orb")).toBeNull();
    const cue = render(
      <WorkStatusCue conversationId="classic-cue" status="working" label="Working" updatedAt="2026-09-01T10:00:00.000Z" workingSince={null} />,
    );
    expect(cue.container.querySelector('.agent-pixel-loader[data-rhythm="orbit"]')).not.toBeNull();
    expect(cue.container.querySelector(".working-orb")).toBeNull();
  });

  it("normalises corrupt provider settings to Classic", () => {
    const view = render(
      <WorkingIndicatorProvider settings={{ style: "rainbow" }}>
        <AgentPixelLoader animated phase="tool" conversationId="c1" />
      </WorkingIndicatorProvider>,
    );
    expect(view.container.querySelector(".agent-pixel-loader")).not.toBeNull();
  });

  it("switches the timeline design by phase without remounting the orb", async () => {
    const view = render(
      <WorkingIndicatorProvider settings={automatic}>
        <AgentPixelLoader animated phase="searching" conversationId="c1" />
      </WorkingIndicatorProvider>,
    );
    const orb = view.container.querySelector(".working-orb");
    expect(orb).toHaveAttribute("data-orb-design", "searching");
    expect(orb).toHaveAttribute("aria-hidden", "true");
    expect(orb).toHaveStyle({ width: "18px", height: "18px" });
    const canvas = await waitFor(() => {
      const element = view.container.querySelector("canvas");
      expect(element).not.toBeNull();
      return element!;
    });
    view.rerender(
      <WorkingIndicatorProvider settings={automatic}>
        <AgentPixelLoader animated phase="waiting-for-input" conversationId="c1" />
      </WorkingIndicatorProvider>,
    );
    expect(view.container.querySelector(".working-orb")).toHaveAttribute("data-orb-design", "listening");
    expect(view.container.querySelector(".working-orb")).toHaveAttribute("data-orb-pace", "0.5");
    expect(view.container.querySelector("canvas")).toBe(canvas);
    expect(sharedOrbLoop().stats().mounted).toBe(1);
    view.unmount();
    expect(sharedOrbLoop().stats()).toMatchObject({ mounted: 0, frameScheduled: false, subscribed: false });
  });

  it("shows the same design and pace in the sidebar cue as in the timeline row for every phase", async () => {
    function Chat({ phase }: { phase: ActiveAgentPhase }): React.JSX.Element {
      usePublishLiveAgentPhase({ conversationId: "synced-chat", turnId: "turn-9", phase });
      return (
        <>
          <div data-testid="timeline"><AgentPixelLoader animated phase={phase} conversationId="synced-chat" /></div>
          <div data-testid="sidebar">
            <WorkStatusCue
              conversationId="synced-chat"
              status="working"
              label="Working"
              updatedAt="2026-09-01T10:00:00.000Z"
              workingSince={null}
              latestTurn={{ id: "turn-9", status: "running" }}
            />
          </div>
        </>
      );
    }
    for (const style of ["automatic", "weaving"] as const) {
      const settings = { ...DEFAULT_WORKING_INDICATOR, style };
      const view = render(<WorkingIndicatorProvider settings={settings}><Chat phase="queued" /></WorkingIndicatorProvider>);
      for (const phase of ALL_PHASES) {
        view.rerender(<WorkingIndicatorProvider settings={settings}><Chat phase={phase} /></WorkingIndicatorProvider>);
        const timeline = screen.getByTestId("timeline").querySelector(".working-orb")!;
        const sidebar = screen.getByTestId("sidebar").querySelector(".working-orb")!;
        expect(sidebar.getAttribute("data-orb-design"), `${style} ${phase}`).toBe(timeline.getAttribute("data-orb-design"));
        expect(sidebar.getAttribute("data-orb-pace"), `${style} ${phase}`).toBe(timeline.getAttribute("data-orb-pace"));
        expect(sidebar).toHaveStyle({ width: "14px" });
      }
      await waitFor(() => expect(sharedOrbLoop().stats().mounted).toBe(2));
      expect(sharedOrbLoop().stats().channels).toBeGreaterThanOrEqual(1);
      view.unmount();
    }
    const unopened = render(
      <WorkingIndicatorProvider settings={automatic}>
        <WorkStatusCue
          conversationId="synced-chat"
          status="working"
          label="Working"
          updatedAt="2026-09-01T10:00:00.000Z"
          workingSince={null}
          latestTurn={{ id: "turn-9", status: "running", runState: { state: "delegated", providerState: null, revision: 2 } }}
        />
      </WorkingIndicatorProvider>,
    );
    expect(unopened.container.querySelector(".working-orb")).toHaveAttribute("data-orb-design", "weaving");
  });

  it("replaces the running activity ring with an orb of the row's kind", () => {
    const view = render(
      <WorkingIndicatorProvider settings={automatic}>
        <ActivityRow activity={runningActivity("command", "npm test")} />
        <ActivityRow activity={runningActivity("tool", "Web search")} />
        <ActivityRow activity={runningActivity("file", "Edit tray.ts")} />
        <ActivityRow activity={{ ...runningActivity("tool", "Done"), status: "completed" }} />
      </WorkingIndicatorProvider>,
    );
    const icons = [...view.container.querySelectorAll(".agent-activity-icon")];
    expect(icons.map((icon) => icon.querySelector(".working-orb")?.getAttribute("data-orb-design") ?? null))
      .toEqual(["working", "searching", "solving", null]);
    expect(icons.map((icon) => icon.getAttribute("data-activity-indicator")))
      .toEqual(["orb", "orb", "orb", null]);
    expect(icons[3]!.querySelector("svg")).not.toBeNull();
  });

  it("keeps the rings when the activity switch is off or the style is Classic", () => {
    for (const settings of [{ ...automatic, activity: false }, DEFAULT_WORKING_INDICATOR]) {
      const view = render(
        <WorkingIndicatorProvider settings={settings}>
          <ActivityRow activity={runningActivity("command", "npm test")} />
          <ReasoningSummary content={"**Plan**\nFirst.\n\n**Check**\nSecond."} streaming />
          <SubagentStatusMark trace={{ status: "running", isLive: true } as SubagentTrace} />
        </WorkingIndicatorProvider>,
      );
      expect(view.container.querySelector(".working-orb")).toBeNull();
      expect(view.container.querySelector("[data-activity-indicator],[data-step-indicator],[data-status-indicator]")).toBeNull();
      view.unmount();
    }
  });

  it("uses a fixed style for reasoning steps and live subagents", () => {
    const settings = { ...DEFAULT_WORKING_INDICATOR, style: "shaping" as const };
    const view = render(
      <WorkingIndicatorProvider settings={settings}>
        <ReasoningSummary content={"**Plan**\nFirst.\n\n**Check**\nSecond."} streaming />
        <SubagentStatusMark trace={{ status: "waiting", isLive: true } as SubagentTrace} />
        <SubagentStatusMark trace={{ status: "completed", isLive: false } as SubagentTrace} />
      </WorkingIndicatorProvider>,
    );
    const steps = [...view.container.querySelectorAll(".turn-reasoning-step")];
    expect(steps.at(-1)).toHaveAttribute("data-step-indicator", "orb");
    expect(steps.at(-1)!.querySelector(".working-orb")).toHaveAttribute("data-orb-design", "shaping");
    expect(steps[0]!.querySelector(".working-orb")).toBeNull();
    const marks = [...view.container.querySelectorAll(".subagent-status-mark")];
    expect(marks[0]).toHaveAttribute("data-status-indicator", "orb");
    expect(marks[0]!.querySelector(".working-orb")).toHaveAttribute("data-orb-pace", "0.5");
    expect(marks[1]!.childElementCount).toBe(0);
  });
});

describe("working indicator settings", () => {
  function renderSettings(settings: unknown = DEFAULT_WORKING_INDICATOR) {
    const onUpdate = vi.fn(async () => undefined);
    const view = render(<WorkingIndicatorSettings settings={settings} disabled={false} onUpdate={onUpdate} />);
    return { view, onUpdate };
  }

  it("offers Classic, Automatic and the nine designs as one radio group", () => {
    renderSettings();
    const group = screen.getByRole("radiogroup", { name: "Working indicator" });
    const radios = [...group.querySelectorAll('[role="radio"]')];
    expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual([
      "Classic", "Automatic", "Working", "Searching", "Solving", "Listening",
      "Connecting", "Weaving", "Composing", "Breathing", "Shaping",
    ]);
    expect(radios.filter((radio) => radio.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(screen.getByRole("radio", { name: "Classic" })).toHaveAttribute("aria-checked", "true");
    expect(group.querySelectorAll(".working-orb")).toHaveLength(10);
  });

  it("moves and selects with arrow keys, Home and End", () => {
    const { onUpdate } = renderSettings();
    const classic = screen.getByRole("radio", { name: "Classic" });
    classic.focus();
    fireEvent.keyDown(classic, { key: "ArrowRight" });
    const automaticRadio = screen.getByRole("radio", { name: "Automatic" });
    expect(automaticRadio).toHaveFocus();
    expect(automaticRadio).toHaveAttribute("aria-checked", "true");
    expect(onUpdate).toHaveBeenLastCalledWith({ workingIndicator: { ...DEFAULT_WORKING_INDICATOR, style: "automatic" } });
    fireEvent.keyDown(automaticRadio, { key: "End" });
    expect(screen.getByRole("radio", { name: "Shaping" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("radio", { name: "Shaping" }), { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "Classic" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("radio", { name: "Classic" }), { key: "ArrowUp" });
    expect(screen.getByRole("radio", { name: "Shaping" })).toHaveAttribute("aria-checked", "true");
    expect(onUpdate).toHaveBeenCalledTimes(4);
  });

  it("composes rapid changes before the saved snapshot arrives", () => {
    const { onUpdate } = renderSettings();
    fireEvent.click(screen.getByRole("radio", { name: "Automatic" }));
    fireEvent.click(screen.getByRole("radio", { name: "Lilac" }));
    fireEvent.click(screen.getByRole("switch", { name: "Glow" }));
    fireEvent.click(screen.getByRole("radio", { name: "Lively" }));
    expect(onUpdate).toHaveBeenLastCalledWith({
      workingIndicator: { ...DEFAULT_WORKING_INDICATOR, style: "automatic", color: "lilac", glow: true, speed: "lively" },
    });
  });

  it("has exactly one control per dimension with unique accessible names", () => {
    const { view } = renderSettings();
    const section = view.container.querySelector(".working-indicator-settings")!;
    const names = [...section.querySelectorAll("button, input:not([aria-hidden='true'])")].map((element) =>
      element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "");
    expect(names.every(Boolean)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    const groups = [...section.querySelectorAll('[role="radiogroup"]')].map((group) =>
      document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent);
    expect(groups).toEqual(["Working indicator", "Colour", "Speed"]);
    expect([...section.querySelectorAll('[role="switch"]')].map((element) => element.getAttribute("aria-label")))
      .toEqual(["Glow", "Use for tool and step activity"]);
    const inputs = section.querySelectorAll('input[type="color"]');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toHaveAttribute("aria-hidden", "true");
    expect(inputs[0]).toHaveAttribute("tabindex", "-1");
    expect(names.filter((name) => /custom/iu.test(name))).toEqual(["Custom colour, #ff5fd2"]);
    expect(section.querySelectorAll('[data-indicator-color="custom"]')).toHaveLength(1);
    expect(section.querySelectorAll("[aria-pressed]")).toHaveLength(0);
    expect(section.textContent).not.toMatch(/neon|preset/iu);
  });

  it("disables glow for theme ink and validates custom colours", () => {
    const { view, onUpdate } = renderSettings();
    expect(screen.getByRole("switch", { name: "Glow" })).toBeDisabled();
    const input = view.container.querySelector('input[type="color"]') as HTMLInputElement;
    fireEvent.input(input, { target: { value: "#12AB9F" } });
    expect(onUpdate).not.toHaveBeenCalled();
    act(() => {
      input.dispatchEvent(new Event("change"));
    });
    expect(onUpdate).toHaveBeenLastCalledWith({
      workingIndicator: { ...DEFAULT_WORKING_INDICATOR, color: "custom", customColor: "#12ab9f" },
    });
    expect(screen.getByRole("radio", { name: "Custom colour, #12ab9f" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Glow" })).toBeEnabled();
  });

  it("opens the native picker from the single Custom swatch but not while arrowing past it", () => {
    const { view } = renderSettings();
    const input = view.container.querySelector('input[type="color"]') as HTMLInputElement;
    const showPicker = vi.fn();
    Object.defineProperty(input, "showPicker", { configurable: true, value: showPicker });
    const rose = screen.getByRole("radio", { name: "Rose" });
    rose.focus();
    fireEvent.keyDown(rose, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "Custom colour, #ff5fd2" })).toHaveAttribute("aria-checked", "true");
    expect(showPicker).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "Custom colour, #ff5fd2" }));
    expect(showPicker).toHaveBeenCalledTimes(1);
  });

  it("reverts the optimistic value when saving fails", async () => {
    const onUpdate = vi.fn(async () => { throw new Error("offline"); });
    render(<WorkingIndicatorSettings settings={DEFAULT_WORKING_INDICATOR} disabled={false} onUpdate={onUpdate} />);
    fireEvent.click(screen.getByRole("radio", { name: "Weaving" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Classic" })).toHaveAttribute("aria-checked", "true"));
  });
});
