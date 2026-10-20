import { activityExecutionCategory } from "../../../shared/activity-display";
import type { AgentActivity, RuntimeMutationEvent } from "../../../shared/contracts";
import {
  MAX_WATCHER_GUARD_PATHS,
  MAX_WATCHER_PAUSE_DETAIL_CHARS,
  type WatcherGuardState,
} from "../../../shared/watcher";
import type { RuntimeStore } from "../../database";
import {
  captureCheckoutFingerprint,
  diffCheckoutFingerprints,
  type CheckoutFingerprint,
  type CheckoutFingerprintOptions,
} from "../../git/checkout-fingerprint";
import { classifyReadOnlyCommand, type ReadOnlyCommandContext } from "./read-only-commands";

export const WATCHER_GUARD_DEADLINE_MS = 10_000;
const MAX_ATTRIBUTION_ACTIVITIES = 200;
const MAX_ATTRIBUTION_TEXT_CHARS = 16_384;
const MAX_ATTRIBUTION_TEXTS = 2_000;

export interface WatcherGuardOutcome {
  state: WatcherGuardState;
  /** Unexplained changed paths, at most `MAX_WATCHER_GUARD_PATHS`. */
  paths: string[];
  /** Set only for `changed`: the bounded banner text for the pause. */
  pauseDetail: string | null;
}

export interface WatcherGuardWindow {
  readonly watcherConversationId: string;
  /**
   * Closes the window after the watcher turn settled. A turn that produced no
   * activity at all is `skipped`: nothing it did could have written.
   */
  after(watcherTurnId: string | null): Promise<WatcherGuardOutcome>;
  dispose(): void;
}

export interface WatcherCheckoutGuardDependencies {
  store: Pick<
    RuntimeStore,
    "conversationPath" | "conversationWork" | "watcherLinks" | "latestAgentTurnForConversation"
    | "workspaceRunsForConversation"
  >;
  turns: { activeConversationIds(): string[] };
  capture?: (path: string, options: CheckoutFingerprintOptions) => Promise<CheckoutFingerprint>;
  clock?: () => number;
  deadlineMs?: number;
  signal?: AbortSignal;
  /** Decides path folding for attribution; defaults to the running platform. */
  platform?: NodeJS.Platform;
}

interface OpenWindow {
  watcherConversationId: string;
  checkoutPath: string | null;
  startedAt: string;
  before: Promise<CheckoutFingerprint>;
  /** Other turns that were active on this checkout during the window. */
  turns: Map<string, Set<string>>;
  matches: Map<string, boolean>;
  texts: string[];
  commandSeen: boolean;
  busy: boolean;
}

const UNAVAILABLE: CheckoutFingerprint = { state: "unavailable", reason: "The checkout could not be resolved." };

function attributionText(activity: Pick<AgentActivity, "title" | "detail">): string {
  return `${activity.title}\n${activity.detail ?? ""}`.slice(0, MAX_ATTRIBUTION_TEXT_CHARS).replaceAll("\\", "/");
}

/**
 * The form a path and the activity texts are compared in. Git reports NFC
 * paths (with `core.precomposeunicode`) while an agent may print NFD, so both
 * sides are NFC. Windows and macOS file systems are case-insensitive by
 * default, so there the comparison also folds case: an edit of `Src/App.tsx`
 * explains Git's `src/App.tsx`.
 */
export function watcherAttributionForm(value: string, platform: NodeJS.Platform): string {
  const normalized = value.replaceAll("\\", "/").normalize("NFC");
  return platform === "win32" || platform === "darwin" ? normalized.toLowerCase() : normalized;
}

const COMMAND_SECTION = "Command:\n";
const NEXT_SECTION = /\n\n(?:Command|Output|Error):\n/u;

function activityCommand(activity: Pick<AgentActivity, "title" | "detail">, title: string): string {
  const detail = activity.detail ?? "";
  if (!detail.startsWith(COMMAND_SECTION)) return title;
  const rest = detail.slice(COMMAND_SECTION.length);
  const end = rest.search(NEXT_SECTION);
  return end < 0 ? rest : rest.slice(0, end);
}

export function watcherActivityMayWrite(
  activity: Pick<AgentActivity, "kind" | "title" | "detail">,
  context: ReadOnlyCommandContext,
): boolean {
  const title = activity.title.replace(/^Interrupted · /u, "");
  if (activity.kind === "command") return !classifyReadOnlyCommand(activityCommand(activity, title), context).allowed;
  return activityExecutionCategory({ kind: activity.kind, title, status: "running" }) === "coding";
}

/** Activities that may have touched files: tool or file work, never reasoning or status lines. */
function mayWrite(activity: Pick<AgentActivity, "kind">): boolean {
  return activity.kind === "file" || activity.kind === "tool";
}

function pauseDetail(paths: readonly string[], total: number, headChanged: boolean): string {
  const lead = headChanged
    ? "The checkout's HEAD moved and files changed during a check, and no running agent accounts for them"
    : "Files changed during a check, and no running agent accounts for them";
  const more = total > paths.length ? ` (+${total - paths.length} more)` : "";
  const text = paths.length > 0 ? `${lead}: ${paths.join(", ")}${more}.` : `${lead}.`;
  return text.length <= MAX_WATCHER_PAUSE_DETAIL_CHARS ? text : `${text.slice(0, MAX_WATCHER_PAUSE_DETAIL_CHARS - 1)}…`;
}

/**
 * The Git fingerprint backstop for read-only watcher checks. It fingerprints
 * the shared checkout before and after a check through read-only Git
 * inspection, then attributes every changed path: a path that another turn on
 * the same checkout reported in its activities is explained; a command run by
 * another turn, a workspace or source-control run, or a terminal resume makes
 * the window inconclusive, and so does a change while the watcher's own turn
 * only read; anything left pauses the watcher. It never writes
 * to the repository and never reuses checkpoints or artifact capture.
 */
export class WatcherCheckoutGuard {
  readonly #deps: WatcherCheckoutGuardDependencies;
  readonly #open = new Set<OpenWindow>();
  readonly #capture: NonNullable<WatcherCheckoutGuardDependencies["capture"]>;
  readonly #clock: () => number;
  readonly #deadlineMs: number;
  readonly #platform: NodeJS.Platform;

  constructor(dependencies: WatcherCheckoutGuardDependencies) {
    this.#deps = dependencies;
    this.#capture = dependencies.capture ?? captureCheckoutFingerprint;
    this.#clock = dependencies.clock ?? Date.now;
    this.#deadlineMs = dependencies.deadlineMs ?? WATCHER_GUARD_DEADLINE_MS;
    this.#platform = dependencies.platform ?? process.platform;
  }

  /** Opens a window and starts the before-fingerprint; resolves once it is taken. */
  async before(watcherConversationId: string): Promise<WatcherGuardWindow> {
    let checkoutPath: string | null = null;
    try {
      checkoutPath = this.#deps.store.conversationPath(watcherConversationId);
    } catch {
      checkoutPath = null;
    }
    const window: OpenWindow = {
      watcherConversationId,
      checkoutPath,
      startedAt: new Date(this.#clock()).toISOString(),
      before: Promise.resolve(UNAVAILABLE),
      turns: new Map(),
      matches: new Map(),
      texts: [],
      commandSeen: false,
      busy: false,
    };
    if (checkoutPath !== null) {
      this.#open.add(window);
      this.#snapshotActiveTurns(window);
      window.before = this.#fingerprint(checkoutPath);
      await window.before;
    }
    return {
      watcherConversationId,
      after: (turnId) => this.#after(window, turnId),
      dispose: () => { this.#open.delete(window); },
    };
  }

  /** Feeds runtime events into every open window. */
  observe(event: RuntimeMutationEvent): void {
    if (this.#open.size === 0) return;
    if (event.type === "agent.started") {
      for (const window of this.#open) this.#noteTurn(window, event.conversationId, event.turnId);
      return;
    }
    if (event.type !== "agent.activity") return;
    const { activity } = event;
    for (const window of this.#open) {
      if (!this.#noteTurn(window, activity.conversationId, activity.turnId)) continue;
      this.#noteActivity(window, activity);
    }
  }

  dispose(): void {
    this.#open.clear();
  }

  async #fingerprint(checkoutPath: string): Promise<CheckoutFingerprint> {
    try {
      return await this.#capture(checkoutPath, {
        // Git deadlines are wall-clock bounds, independent of the injected clock.
        deadlineAt: Date.now() + this.#deadlineMs,
        ...(this.#deps.signal ? { signal: this.#deps.signal } : {}),
      });
    } catch {
      return { state: "unavailable", reason: "The checkout fingerprint could not be taken." };
    }
  }

  #matches(window: OpenWindow, conversationId: string): boolean {
    if (conversationId === window.watcherConversationId || window.checkoutPath === null) return false;
    let matches = window.matches.get(conversationId);
    if (matches === undefined) {
      try {
        matches = this.#deps.store.conversationWork.conversationMatchesCheckout(conversationId, window.checkoutPath);
      } catch {
        matches = false;
      }
      window.matches.set(conversationId, matches);
    }
    return matches;
  }

  #noteTurn(window: OpenWindow, conversationId: string, turnId: string | null): boolean {
    if (!this.#matches(window, conversationId)) return false;
    if (turnId) {
      const turns = window.turns.get(conversationId) ?? new Set<string>();
      turns.add(turnId);
      window.turns.set(conversationId, turns);
    }
    return true;
  }

  #noteActivity(window: OpenWindow, activity: AgentActivity, inWindowOnly = false): void {
    if (activity.kind === "command") {
      if (!inWindowOnly || activity.createdAt >= window.startedAt || activity.status === "running") {
        window.commandSeen = true;
      }
      return;
    }
    if (mayWrite(activity) && window.texts.length < MAX_ATTRIBUTION_TEXTS) {
      window.texts.push(attributionText(activity));
    }
  }

  #snapshotActiveTurns(window: OpenWindow): void {
    if (window.checkoutPath === null) return;
    try {
      if (this.#deps.store.conversationWork.hasCheckout(window.checkoutPath)) window.busy = true;
    } catch {
      window.busy = true;
    }
    for (const conversationId of this.#deps.turns.activeConversationIds()) {
      if (!this.#matches(window, conversationId)) continue;
      const turn = this.#deps.store.latestAgentTurnForConversation(conversationId);
      if (!turn) continue;
      this.#noteTurn(window, conversationId, turn.id);
      for (const activity of this.#activities(conversationId, turn.id)) {
        if (activity.kind === "command" && activity.status === "running") window.commandSeen = true;
      }
    }
  }

  /** A check, service or source-control run of this chat; agent runs are attributed by activity. */
  #workspaceRunActive(conversationId: string): boolean {
    try {
      return this.#deps.store.workspaceRunsForConversation(conversationId).some((run) =>
        run.kind !== "agent" && (run.status === "running" || run.status === "waiting"));
    } catch {
      return true;
    }
  }

  #activities(conversationId: string, turnId: string): AgentActivity[] {
    try {
      return this.#deps.store.watcherLinks.digest.activitiesAfter(
        conversationId,
        turnId,
        { at: null, id: null },
        MAX_ATTRIBUTION_ACTIVITIES,
      );
    } catch {
      return [];
    }
  }

  async #after(window: OpenWindow, turnId: string | null): Promise<WatcherGuardOutcome> {
    try {
      const before = await window.before;
      const own = turnId === null ? [] : this.#activities(window.watcherConversationId, turnId);
      if (own.length === 0) return { state: "skipped", paths: [], pauseDetail: null };
      if (before.state !== "captured" || window.checkoutPath === null) {
        return { state: "unavailable", paths: [], pauseDetail: null };
      }
      const after = await this.#fingerprint(window.checkoutPath);
      if (after.state !== "captured" || after.root !== before.root) {
        return { state: "unavailable", paths: [], pauseDetail: null };
      }
      const diff = diffCheckoutFingerprints(before, after);
      if (!diff.headChanged && diff.changedPaths.length === 0) return { state: "clean", paths: [], pauseDetail: null };
      const endedAt = new Date(this.#clock()).toISOString();
      this.#attributeFromStore(window, endedAt);
      const texts = window.texts.map((text) => watcherAttributionForm(text, this.#platform));
      const unexplained = diff.changedPaths.filter((path) => {
        const normalized = watcherAttributionForm(path, this.#platform);
        return !texts.some((text) => text.includes(normalized));
      });
      if (!diff.headChanged && unexplained.length === 0) return { state: "clean", paths: [], pauseDetail: null };
      const paths = unexplained.slice(0, MAX_WATCHER_GUARD_PATHS);
      const context: ReadOnlyCommandContext = { cwd: window.checkoutPath, windows: this.#platform === "win32" };
      if (window.commandSeen || window.busy || !own.some((activity) => watcherActivityMayWrite(activity, context))) {
        return { state: "inconclusive", paths, pauseDetail: null };
      }
      return { state: "changed", paths, pauseDetail: pauseDetail(paths, unexplained.length, diff.headChanged) };
    } finally {
      this.#open.delete(window);
    }
  }

  /** Adds durable activities of every overlapping turn, which covers events missed in memory. */
  #attributeFromStore(window: OpenWindow, endedAt: string): void {
    for (const [conversationId, turnIds] of window.turns) {
      if (this.#workspaceRunActive(conversationId)) window.busy = true;
      for (const turnId of turnIds) {
        for (const activity of this.#activities(conversationId, turnId)) {
          if (activity.createdAt > endedAt) continue;
          this.#noteActivity(window, activity, true);
        }
      }
    }
    try {
      if (window.checkoutPath !== null && this.#deps.store.conversationWork.hasCheckout(window.checkoutPath)) {
        window.busy = true;
      }
    } catch {
      window.busy = true;
    }
  }
}
