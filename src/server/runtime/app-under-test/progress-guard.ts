import { MAX_APP_AGENT_SCREENSHOTS_PER_TURN } from "../../../shared/app-under-test";
import { hostToolDigest } from "../host-tool-digest";

/**
 * Per-turn state of the App pack that keeps an agent from looping: identical
 * calls that keep failing, inputs that keep changing nothing, and the
 * model-visible screenshot allowance. Everything is bounded (least recently
 * used turns go first) and forgotten when the turn settles; a call that
 * finishes after its turn settled leaves nothing behind.
 */

export const APP_REPEATED_FAILURE_LIMIT = 3;
export const APP_NO_CHANGE_LIMIT = 3;
const MAX_TRACKED_TURNS = 32;
const MAX_TRACKED_CALLS = 64;
const MAX_TRACKED_WINDOWS = 16;
/** Settled turns remembered so a late call does not bring their state back. */
const MAX_SETTLED_TURNS = 64;

export const APP_REPEATED_FAILURE_MESSAGE = "The same action failed three times. Take a new snapshot, change the approach, or ask the user.";
export const APP_NO_VISIBLE_CHANGE_MESSAGE = "Three actions in a row reached the app but the next snapshot showed no visible change. Take a new snapshot, change the approach, or ask the user.";

/** The inputs the no-visible-change rule counts and refuses; activation, stop and the read-only tools never are. */
export const APP_VISIBLE_CHANGE_TOOLS: ReadonlySet<string> = new Set([
  "inertia_app_click", "inertia_app_type", "inertia_app_press", "inertia_app_scroll",
]);

interface WindowProgress {
  /** Document sequence and digest of the latest snapshot's text, viewport and elements. */
  last: string | null;
  /** The snapshot before the actions that await a follow-up snapshot. */
  before: string | null;
  awaiting: boolean;
  unchanged: number;
}

interface TurnProgress {
  failures: Map<string, number>;
  blocked: Set<string>;
  /** The failing call keys that name each window, so a change in the window clears them. */
  windowKeys: Map<string, Set<string>>;
  windows: Map<string, WindowProgress>;
  screenshots: number;
}

function remember<K, V>(map: Map<K, V>, key: K, value: V, maximum: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > maximum) map.delete(map.keys().next().value as K);
}

/** Trimmed strings, at any depth; key order is handled by the digest. */
function canonical(value: unknown): unknown {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

/** Identical tool and arguments, independent of key order and surrounding whitespace. */
export function appCallKey(tool: string, args: unknown): string {
  return hostToolDigest({ tool, arguments: canonical(args ?? null) });
}

/** What a follow-up snapshot compares: the document, its visible text, its viewport and its exact element list. */
export function appSnapshotFingerprint(
  documentSequence: number | null,
  snapshot: { elements?: unknown; text?: unknown; viewport?: unknown },
): string {
  return `${documentSequence ?? "?"}:${hostToolDigest({
    elements: snapshot.elements ?? null,
    text: snapshot.text ?? null,
    viewport: snapshot.viewport ?? null,
  })}`;
}

export class AppProgressGuard {
  private readonly turns = new Map<string, TurnProgress>();
  private readonly settled = new Set<string>();

  /** True when this exact call already failed three times in a row this turn. */
  repeated(turnId: string, key: string): boolean {
    return this.existing(turnId)?.blocked.has(key) === true;
  }

  /** `windowId` names the window the call targets, so a visible change there clears its count. */
  recordOutcome(turnId: string, key: string, failed: boolean, windowId?: string): void {
    const turn = this.turn(turnId);
    if (!turn) return;
    if (!failed) {
      turn.failures.delete(key);
      return;
    }
    const count = (turn.failures.get(key) ?? 0) + 1;
    remember(turn.failures, key, count, MAX_TRACKED_CALLS);
    if (windowId !== undefined) {
      const keys = turn.windowKeys.get(windowId) ?? new Set<string>();
      keys.add(key);
      while (keys.size > MAX_TRACKED_CALLS) keys.delete(keys.values().next().value as string);
      remember(turn.windowKeys, windowId, keys, MAX_TRACKED_WINDOWS);
    }
    if (count >= APP_REPEATED_FAILURE_LIMIT) {
      turn.blocked.add(key);
      while (turn.blocked.size > MAX_TRACKED_CALLS) turn.blocked.delete(turn.blocked.values().next().value as string);
    }
  }

  /** The window changed (it was brought to the front, or a snapshot differs): its failing calls may work now. */
  clearWindow(turnId: string, windowId: string): void {
    const turn = this.existing(turnId);
    const keys = turn?.windowKeys.get(windowId);
    if (!turn || !keys) return;
    for (const key of keys) {
      turn.failures.delete(key);
      turn.blocked.delete(key);
    }
    turn.windowKeys.delete(windowId);
  }

  /** A click, type, press or scroll reached the app; the next snapshot of the window tells whether anything changed. */
  recordAction(turnId: string, windowId: string): void {
    const window = this.window(turnId, windowId);
    if (!window) return;
    if (!window.awaiting) window.before = window.last;
    window.awaiting = true;
  }

  recordSnapshot(turnId: string, windowId: string, fingerprint: string): void {
    const window = this.window(turnId, windowId);
    if (!window) return;
    if (window.awaiting && window.before !== null) {
      window.unchanged = fingerprint === window.before ? window.unchanged + 1 : 0;
    } else if (fingerprint !== window.last) {
      window.unchanged = 0;
    }
    // A snapshot that differs from the window's previous one this turn is new information.
    if (window.last !== null && fingerprint !== window.last) this.clearWindow(turnId, windowId);
    window.awaiting = false;
    window.before = null;
    window.last = fingerprint;
  }

  /**
   * True once, for the input after three inputs in a row whose follow-up
   * snapshot showed no change; the count starts again after it.
   */
  noVisibleChange(turnId: string, windowId: string): boolean {
    const window = this.existing(turnId)?.windows.get(windowId);
    if (!window || window.unchanged < APP_NO_CHANGE_LIMIT) return false;
    window.unchanged = 0;
    return true;
  }

  /** Takes one of the turn's model-visible screenshots; false when the allowance is spent. */
  reserveScreenshot(turnId: string): boolean {
    const turn = this.turn(turnId);
    // A settled turn's call keeps no allowance state.
    if (!turn) return true;
    if (turn.screenshots >= MAX_APP_AGENT_SCREENSHOTS_PER_TURN) return false;
    turn.screenshots += 1;
    return true;
  }

  /** Returns a reservation whose image never reached the model. */
  releaseScreenshot(turnId: string): void {
    const turn = this.existing(turnId);
    if (turn && turn.screenshots > 0) turn.screenshots -= 1;
  }

  settle(turnId: string): void {
    this.turns.delete(turnId);
    this.settled.delete(turnId);
    this.settled.add(turnId);
    while (this.settled.size > MAX_SETTLED_TURNS) this.settled.delete(this.settled.values().next().value as string);
  }

  get trackedTurns(): number {
    return this.turns.size;
  }

  /** The turn's state, marked most recently used; never created for a settled turn. */
  private existing(turnId: string): TurnProgress | undefined {
    const turn = this.turns.get(turnId);
    if (turn) {
      this.turns.delete(turnId);
      this.turns.set(turnId, turn);
    }
    return turn;
  }

  private turn(turnId: string): TurnProgress | null {
    const existing = this.existing(turnId);
    if (existing) return existing;
    if (this.settled.has(turnId)) return null;
    const turn: TurnProgress = { failures: new Map(), blocked: new Set(), windowKeys: new Map(), windows: new Map(), screenshots: 0 };
    remember(this.turns, turnId, turn, MAX_TRACKED_TURNS);
    return turn;
  }

  private window(turnId: string, windowId: string): WindowProgress | null {
    const turn = this.turn(turnId);
    if (!turn) return null;
    let window = turn.windows.get(windowId);
    if (!window) {
      window = { last: null, before: null, awaiting: false, unchanged: 0 };
      remember(turn.windows, windowId, window, MAX_TRACKED_WINDOWS);
    }
    return window;
  }
}
