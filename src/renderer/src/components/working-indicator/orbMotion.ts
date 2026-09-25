import type { AgentActivity, SubagentTraceStatus } from "@shared/contracts/agent";
import type {
  OrbDesign,
  WorkingIndicatorSettings,
} from "@shared/working-indicator";
import type {
  ActiveAgentPhase,
  ActivityExecutionCategory,
} from "../../utils/response-timeline/active-state";

export interface OrbMotion {
  design: OrbDesign;
  pace: number;
}

const BUSY: OrbMotion = { design: "working", pace: 1 };
const CALM: OrbMotion = { design: "breathing", pace: 1 };
const ATTENTION: OrbMotion = { design: "listening", pace: 0.5 };

export const PHASE_ORB_MOTION = {
  queued: CALM,
  starting: CALM,
  thinking: CALM,
  searching: { design: "searching", pace: 1 },
  coding: { design: "solving", pace: 1 },
  command: BUSY,
  tool: { design: "connecting", pace: 1 },
  responding: { design: "composing", pace: 1 },
  working: BUSY,
  delegated: { design: "weaving", pace: 1 },
  retrying: BUSY,
  compacting: { design: "shaping", pace: 1 },
  cancelling: { design: "breathing", pace: 0.5 },
  "waiting-for-approval": ATTENTION,
  "waiting-for-input": ATTENTION,
} as const satisfies Record<ActiveAgentPhase, OrbMotion>;

export const ACTIVITY_ORB_MOTION = {
  reasoning: CALM,
  searching: { design: "searching", pace: 1 },
  coding: { design: "solving", pace: 1 },
  command: BUSY,
  tool: { design: "connecting", pace: 1 },
  attention: BUSY,
} as const satisfies Record<ActivityExecutionCategory, OrbMotion>;

export const SUBAGENT_ORB_MOTION = {
  queued: CALM,
  spawned: CALM,
  running: { design: "weaving", pace: 1 },
  waiting: ATTENTION,
  completed: BUSY,
  failed: BUSY,
  cancelled: BUSY,
  interrupted: BUSY,
  lost: BUSY,
  unknown: BUSY,
} as const satisfies Record<SubagentTraceStatus, OrbMotion>;

function lookup<T>(table: Readonly<Record<string, T>>, key: unknown, fallback: T): T {
  return typeof key === "string" && Object.hasOwn(table, key) ? table[key]! : fallback;
}

export function orbMotionForPhase(phase: ActiveAgentPhase | string | null | undefined): OrbMotion {
  return lookup<OrbMotion>(PHASE_ORB_MOTION, phase, BUSY);
}

export function orbMotionForActivity(
  activity: Pick<AgentActivity, "kind">,
  category: ActivityExecutionCategory | string,
): OrbMotion {
  if (activity.kind === "status") return BUSY;
  return lookup<OrbMotion>(ACTIVITY_ORB_MOTION, category, BUSY);
}

export function orbMotionForSubagent(status: SubagentTraceStatus | string): OrbMotion {
  return lookup<OrbMotion>(SUBAGENT_ORB_MOTION, status, BUSY);
}

export function workingOrbSyncKey(conversationId: string): string {
  return `conversation:${conversationId}`;
}

export function usesOrbs(settings: Pick<WorkingIndicatorSettings, "style">): boolean {
  return settings.style !== "classic";
}

export function usesActivityOrbs(
  settings: Pick<WorkingIndicatorSettings, "style" | "activity">,
): boolean {
  return settings.style === "automatic" && settings.activity;
}

export function resolveOrbMotion(
  settings: Pick<WorkingIndicatorSettings, "style">,
  motion: OrbMotion,
): OrbMotion {
  if (settings.style === "automatic" || settings.style === "classic") return motion;
  return settings.style === motion.design ? motion : { design: settings.style, pace: motion.pace };
}
