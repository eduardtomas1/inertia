import type { AgentRunState } from "./run-state";
import type { MascotSpriteImport, MascotSprites, MascotTemplateExport } from "./mascot-sprites";

export const MASCOT_IPC = {
  preferences: "inertia:mascot-preferences",
  configure: "inertia:mascot-configure",
  changed: "inertia:mascot-changed",
  snapshot: "inertia:mascot-snapshot",
  action: "inertia:mascot-action",
  sprites: "inertia:mascot-sprites",
} as const;

export type MascotPhase = AgentRunState | "idle" | "unavailable";
export interface MascotStatus {
  phase: MascotPhase;
  projectId: string | null;
  conversationId: string | null;
  runId: string | null;
  turnId: string | null;
  activeCount: number;
  chatTitle: string | null;
  projectName: string | null;
  /** Bounded plain-text preview from this turn's public activity or interaction. */
  message: string | null;
  progress: string | null;
  steps: MascotSteps | null;
  since: string | null;
}
export interface MascotSteps {
  completed: number;
  total: number;
}
export const MASCOT_CHAT_LIMIT = 8;
export interface MascotPreferences {
  enabled: boolean;
  motion: boolean;
}
export interface MascotSnapshot {
  status: MascotStatus;
  preferences: MascotPreferences;
  /** Native Wayland delegates global placement to the compositor. */
  placement?: "system";
  /** Transient window interaction, independent of the current agent activity. */
  dragging?: boolean;
  /** Renderer lifetime and monotonically increasing pointer gesture. */
  gesture?: MascotGesture;
  sprites?: MascotSprites;
  chats?: readonly MascotStatus[];
  attention?: number;
  pinned?: string | null;
}
export type MascotGesture = readonly [rendererEpoch: number, sequence: number];
export type MascotAction = "open-chat" | "hide" | "pause" | "resume" | "focus"
  | "left" | "right" | "up" | "down" | "reset-position" | "pickup" | "drop" | "pin";

export const MASCOT_ACTIONS: readonly MascotAction[] = [
  "open-chat", "hide", "pause", "resume", "focus", "left", "right", "up", "down", "reset-position", "pickup", "drop", "pin",
];
export const MASCOT_LABELS: Record<MascotPhase, string> = {
  idle: "Ready when you are",
  unavailable: "Reconnecting to Inertia",
  queued: "Queued",
  starting: "Starting",
  running: "Working",
  delegated: "Delegated work",
  retrying: "Retrying",
  "waiting-for-approval": "Approval needed",
  "waiting-for-input": "Your input needed",
  cancelling: "Stopping",
  completed: "Work complete",
  failed: "Something went wrong",
  cancelled: "Work cancelled",
  interrupted: "Work interrupted",
};

export function emptyMascotStatus(phase: "idle" | "unavailable" = "idle"): MascotStatus {
  return { phase, projectId: null, conversationId: null, runId: null, turnId: null, activeCount: 0,
    chatTitle: null, projectName: null, message: null, progress: null, steps: null, since: null };
}

export function isLiveMascotPhase(phase: MascotPhase): boolean {
  return !["idle", "unavailable", "completed", "failed", "cancelled", "interrupted"].includes(phase);
}

export function parseMascotStatus(value: unknown): MascotStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).length !== 12
    || typeof candidate.phase !== "string"
    || !Object.hasOwn(MASCOT_LABELS, candidate.phase)
    || !Number.isSafeInteger(candidate.activeCount)
    || (candidate.activeCount as number) < 0
    || (candidate.activeCount as number) > 1_000_000) return null;
  const empty = candidate.phase === "idle" || candidate.phase === "unavailable";
  for (const key of ["projectId", "conversationId", "runId", "turnId"] as const) {
    const id = candidate[key];
    if (empty ? id !== null : typeof id !== "string" || id.length < 1 || id.length > 200 || /[\x00-\x1f\x7f]/u.test(id)) return null;
  }
  for (const [key, limit] of [["chatTitle", 96], ["projectName", 64], ["message", 280], ["progress", 80]] as const) {
    const text = candidate[key];
    if (text !== null && (empty || typeof text !== "string" || !text.length || text.length > limit
      || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(text))) return null;
  }
  const { steps, since } = candidate;
  if (steps !== null) {
    if (empty || !steps || typeof steps !== "object" || Array.isArray(steps)) return null;
    const { completed, total } = steps as Record<string, unknown>;
    if (Object.keys(steps).length !== 2 || !Number.isSafeInteger(total) || !Number.isSafeInteger(completed)
      || (total as number) < 1 || (total as number) > 1_000
      || (completed as number) < 0 || (completed as number) > (total as number)) return null;
  }
  if (since !== null && (empty || typeof since !== "string" || since.length > 40
    || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(since) || !Number.isFinite(Date.parse(since)))) return null;
  return candidate as unknown as MascotStatus;
}

export function isMascotAttention(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000;
}

export function isMascotFocus(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/u.test(value));
}

export function parseMascotChats(value: unknown): MascotStatus[] | null {
  if (!Array.isArray(value) || value.length > MASCOT_CHAT_LIMIT) return null;
  const chats: MascotStatus[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    const status = parseMascotStatus(item);
    if (!status?.conversationId || ids.has(status.conversationId)) return null;
    ids.add(status.conversationId);
    chats.push(status);
  }
  return chats;
}

export function parseMascotPreferences(value: unknown): MascotPreferences | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).length === 2
    && typeof candidate.enabled === "boolean" && typeof candidate.motion === "boolean"
    ? { enabled: candidate.enabled, motion: candidate.motion } : null;
}

export interface MascotBridge {
  snapshot(): Promise<MascotSnapshot>;
  onChanged(listener: (snapshot: MascotSnapshot) => void): () => void;
  action(action: MascotAction, expected?: MascotStatus | MascotGesture | string | null): Promise<void>;
}

export interface MascotSettingsBridge extends MascotBridge {
  configure(preferences: MascotPreferences): Promise<MascotSnapshot>;
  importSprites(): Promise<MascotSpriteImport>;
  applySprites(id: string): Promise<MascotSnapshot>;
  resetSprites(): Promise<MascotSnapshot>;
  exportSpriteTemplate(): Promise<MascotTemplateExport>;
}
