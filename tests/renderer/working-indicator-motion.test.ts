import { describe, expect, it } from "vitest";

import { ORB_DESIGNS, type WorkingIndicatorStyle } from "../../src/shared/working-indicator";
import {
  ACTIVITY_ORB_MOTION,
  orbMotionForActivity,
  orbMotionForPhase,
  orbMotionForSubagent,
  PHASE_ORB_MOTION,
  resolveOrbMotion,
  SUBAGENT_ORB_MOTION,
  usesActivityOrbs,
  usesOrbs,
  workingOrbSyncKey,
} from "../../src/renderer/src/components/working-indicator/orbMotion";
import {
  activeAgentPhase,
  activeAgentPresentation,
  type ActiveAgentPhase,
} from "../../src/renderer/src/utils/response-timeline/active-state";

const ALL_PHASES: readonly ActiveAgentPhase[] = [
  "compacting", "queued", "starting", "thinking", "searching", "coding", "command", "tool",
  "responding", "working", "delegated", "retrying", "cancelling",
  "waiting-for-approval", "waiting-for-input",
];

describe("Automatic phase mapping", () => {
  it("maps every active agent phase to the approved design", () => {
    expect(Object.keys(PHASE_ORB_MOTION).sort()).toEqual([...ALL_PHASES].sort());
    expect(Object.fromEntries(ALL_PHASES.map((phase) => [phase, orbMotionForPhase(phase)]))).toEqual({
      queued: { design: "breathing", pace: 1 },
      starting: { design: "breathing", pace: 1 },
      thinking: { design: "breathing", pace: 1 },
      searching: { design: "searching", pace: 1 },
      coding: { design: "solving", pace: 1 },
      command: { design: "working", pace: 1 },
      tool: { design: "connecting", pace: 1 },
      responding: { design: "composing", pace: 1 },
      working: { design: "working", pace: 1 },
      delegated: { design: "weaving", pace: 1 },
      retrying: { design: "working", pace: 1 },
      compacting: { design: "shaping", pace: 1 },
      cancelling: { design: "breathing", pace: 0.5 },
      "waiting-for-approval": { design: "listening", pace: 0.5 },
      "waiting-for-input": { design: "listening", pace: 0.5 },
    });
  });

  it("falls back to Working for unknown, empty or inherited phase names", () => {
    for (const unknown of ["sparkling", "", "constructor", "toString", "__proto__", null, undefined]) {
      expect(orbMotionForPhase(unknown)).toEqual({ design: "working", pace: 1 });
    }
  });

  it("maps running activity rows by their own kind", () => {
    expect(orbMotionForActivity({ kind: "command" }, "command").design).toBe("working");
    expect(orbMotionForActivity({ kind: "tool" }, "tool").design).toBe("connecting");
    expect(orbMotionForActivity({ kind: "tool" }, "searching").design).toBe("searching");
    expect(orbMotionForActivity({ kind: "file" }, "coding").design).toBe("solving");
    expect(orbMotionForActivity({ kind: "reasoning" }, "reasoning").design).toBe("breathing");
    expect(orbMotionForActivity({ kind: "status" }, "tool").design).toBe("working");
    expect(orbMotionForActivity({ kind: "tool" }, "mystery").design).toBe("working");
    expect(Object.keys(ACTIVITY_ORB_MOTION).sort()).toEqual(
      ["attention", "coding", "command", "reasoning", "searching", "tool"],
    );
  });

  it("weaves running subagents and slows waiting ones", () => {
    expect(orbMotionForSubagent("running")).toEqual({ design: "weaving", pace: 1 });
    expect(orbMotionForSubagent("queued")).toEqual({ design: "breathing", pace: 1 });
    expect(orbMotionForSubagent("waiting")).toEqual({ design: "listening", pace: 0.5 });
    expect(orbMotionForSubagent("new-status")).toEqual({ design: "working", pace: 1 });
    expect(Object.keys(SUBAGENT_ORB_MOTION)).toHaveLength(10);
  });

  it("keeps the phase pace but uses the chosen design for a fixed style", () => {
    for (const design of ORB_DESIGNS) {
      const style = design as WorkingIndicatorStyle;
      expect(resolveOrbMotion({ style }, orbMotionForPhase("tool"))).toEqual({ design, pace: 1 });
      expect(resolveOrbMotion({ style }, orbMotionForPhase("waiting-for-input"))).toEqual({ design, pace: 0.5 });
    }
    expect(resolveOrbMotion({ style: "automatic" }, orbMotionForPhase("coding"))).toEqual({ design: "solving", pace: 1 });
  });

  it("only replaces the Classic indicators when a design is chosen", () => {
    expect(usesOrbs({ style: "classic" })).toBe(false);
    expect(usesOrbs({ style: "automatic" })).toBe(true);
    expect(usesActivityOrbs({ style: "classic", activity: true })).toBe(false);
    expect(usesActivityOrbs({ style: "weaving", activity: false })).toBe(false);
    for (const style of ORB_DESIGNS) expect(usesActivityOrbs({ style, activity: true })).toBe(false);
    expect(usesActivityOrbs({ style: "automatic", activity: true })).toBe(true);
    expect(usesActivityOrbs({ style: "automatic", activity: false })).toBe(false);
    expect(workingOrbSyncKey("abc")).toBe("conversation:abc");
  });
});

describe("shared phase derivation", () => {
  const runningTurn = { status: "running" as const };

  it("returns exactly the presentation phase the timeline shows", () => {
    const activities = [{
      id: "a", conversationId: "c", runId: "r", turnId: "t", kind: "tool" as const,
      title: "Web search", detail: null, status: "running" as const, createdAt: "2026-09-01T10:00:00.000Z",
    }];
    for (const streamingChannel of ["text", "reasoning", null] as const) {
      for (const turnActivities of [activities, []]) {
        const turn = { agentTurn: runningTurn, activities: turnActivities };
        expect(activeAgentPhase({ turn, streamingChannel })).toBe(
          activeAgentPresentation({ turn, providerLabel: "Codex", streamingChannel }).phase,
        );
      }
    }
  });

  it("derives lifecycle phases from the run state alone", () => {
    const phaseFor = (state: string) => activeAgentPhase({
      turn: {
        agentTurn: { status: "running", runState: { state: state as never, providerState: null, revision: 1 } },
        activities: [],
      },
      streamingChannel: null,
    });
    expect(phaseFor("queued")).toBe("queued");
    expect(phaseFor("delegated")).toBe("delegated");
    expect(phaseFor("waiting-for-approval")).toBe("waiting-for-approval");
    expect(phaseFor("cancelling")).toBe("cancelling");
    expect(phaseFor("running")).toBe("working");
  });
});
