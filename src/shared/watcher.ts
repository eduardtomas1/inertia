import { z } from "zod";

/**
 * Reviewed allowlist of harnesses that can host a read-only watcher. This is
 * deliberately separate from provider capability ids: adding a capability id
 * would change every harness's attestation digest and break session resume.
 */
export const WATCHER_HARNESS_IDS = ["claude-agent-sdk", "codex-app-server", "opencode-sdk"] as const;
export const WATCHER_PRESETS = ["reviewer", "scope-guard", "explainer"] as const;
export const WATCHER_STATUSES = ["watching", "waking", "idle", "paused", "detached"] as const;
export const WATCHER_PAUSE_REASONS = [
  "user", "wake-budget", "usage-limit", "write-detected", "write-attempts",
  "route-unavailable", "watched-archived", "watcher-archived",
] as const;
export const WATCHER_DETACH_REASONS = ["user", "watched-deleted"] as const;
export const WATCHER_WAKE_TRIGGERS = ["activity", "plan", "error", "turn-end", "manual", "initial"] as const;
/** `command-attempt` is only a command approval that was requested and denied. */
export const WATCHER_WAKE_OUTCOMES = [
  "silent", "finding", "failed", "cancelled", "usage-limited", "permission-declined",
  "write-attempt", "command-attempt", "write-detected",
] as const;
export const WATCHER_GUARD_STATES = ["clean", "inconclusive", "changed", "unavailable", "skipped"] as const;
export const WATCHER_WAKE_STATES = ["dispatching", "running", "settled"] as const;
export const WATCHER_DELIVERY_MODES = ["queue", "steer"] as const;
export const WATCHER_DELIVERY_STATES = ["queued", "sent", "dismissed", "failed"] as const;
export const WATCHER_PRIVATE_CONNECT_VISIBILITIES = ["inherit", "hidden"] as const;
export const WATCHER_DELIVERY_POLICIES = ["manual", "auto"] as const;
export const WATCHER_LIVE_PHASES = ["starting", "reading", "searching", "thinking", "writing"] as const;

export const WATCHER_PRESET_LABELS: Readonly<Record<(typeof WATCHER_PRESETS)[number], string>> = {
  reviewer: "Reviewer",
  "scope-guard": "Scope guard",
  explainer: "Explainer",
};

export const MAX_ACTIVE_WATCHERS = 8;
export const MAX_WATCHER_INSTRUCTIONS_CHARS = 2_000;
export const MAX_WATCHER_NOTE_CHARS = 8_000;
export const MAX_WATCHER_FEED_PAGE = 20;
export const MAX_WATCHER_FINDING_BYTES = 8 * 1_024;
export const MAX_WATCHER_GUARD_PATHS = 20;
export const MAX_WATCHER_LABEL_CHARS = 80;
export const MAX_WATCHER_HEADLINE_CHARS = 200;
export const MAX_WATCHER_LIVE_LABEL_CHARS = 120;
export const MAX_WATCHER_PAUSE_DETAIL_CHARS = 1_000;
export const MAX_WATCHER_DELIVERY_DETAIL_CHARS = 1_000;
export const MAX_WATCHER_PENDING_RUNNING_IDS = 64;
export const WATCHER_WAKE_RETENTION = 500;
export const MAX_WATCHER_LINKS_SERIALIZED_BYTES = 64 * 1_024;

const UTF8 = new TextEncoder();
const utf8Bytes = (value: string): number => UTF8.encode(value).byteLength;
const timestampSchema = z.string().datetime({ offset: true });
const countSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const turnIdSchema = z.string().min(1).max(200);
const singleLine = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
};

/**
 * Replaces NEL, LINE SEPARATOR and PARAGRAPH SEPARATOR, which renderers and
 * models treat as line breaks, so quoted text cannot step outside its quote.
 */
export function watcherReplaceLineSeparators(value: string, replacement: string): string {
  return value.replace(/[\u0085\u2028\u2029]/gu, replacement);
}

/** True when every UTF-16 surrogate is paired, so JSON never escapes it to six bytes. */
function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

/**
 * One printable line: no C0 controls, DEL, C1 controls or line separators, and
 * no lone surrogates. Each code unit then serializes to at most three bytes of
 * JSON, which is what keeps the shell projection's size provable.
 */
export function watcherPrintableLine(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return false;
  }
  return wellFormed(value);
}

/** Replaces controls and separators with spaces and lone surrogates with U+FFFD. */
export function watcherPrintableText(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        result += value[index]! + value[index + 1]!;
        index += 1;
      } else {
        result += "\uFFFD";
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      result += "\uFFFD";
    } else if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      result += " ";
    } else {
      result += value[index]!;
    }
  }
  return result;
}

/** Instructions may use newlines and tabs; every other control character is refused. */
function instructionCharactersAllowed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 0x20 && code !== 0x0a && code !== 0x09) || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return wellFormed(value);
}

export const watcherPresetSchema = z.enum(WATCHER_PRESETS);
export const watcherStatusSchema = z.enum(WATCHER_STATUSES);
export const watcherPauseReasonSchema = z.enum(WATCHER_PAUSE_REASONS);
export const watcherDetachReasonSchema = z.enum(WATCHER_DETACH_REASONS);
export const watcherWakeTriggerSchema = z.enum(WATCHER_WAKE_TRIGGERS);
export const watcherWakeOutcomeSchema = z.enum(WATCHER_WAKE_OUTCOMES);
export const watcherGuardStateSchema = z.enum(WATCHER_GUARD_STATES);
export const watcherWakeStateSchema = z.enum(WATCHER_WAKE_STATES);
export const watcherDeliveryModeSchema = z.enum(WATCHER_DELIVERY_MODES);
export const watcherDeliveryStateSchema = z.enum(WATCHER_DELIVERY_STATES);
export const watcherPrivateConnectSchema = z.enum(WATCHER_PRIVATE_CONNECT_VISIBILITIES);
export const watcherDeliveryPolicySchema = z.enum(WATCHER_DELIVERY_POLICIES);
export const watcherLivePhaseSchema = z.enum(WATCHER_LIVE_PHASES);

export const watcherInstructionsSchema = z.string()
  .max(MAX_WATCHER_INSTRUCTIONS_CHARS)
  .refine(instructionCharactersAllowed, "Watcher instructions can use newlines and tabs but no other control characters.");

export const watcherSharingSchema = z.strictObject({
  brief: z.boolean(),
  activities: z.boolean(),
  changedFiles: z.boolean(),
  partialReplies: z.boolean(),
});

export const WATCHER_BUDGET_LIMITS = {
  wakesPerWatchedTurn: { min: 2, max: 100, default: 30 },
  cooldownSeconds: { min: 15, max: 600, default: 45 },
  digestKiB: { min: 4, max: 48, default: 24 },
  contextReadsPerWake: { min: 0, max: 8, default: 4 },
} as const;
type WatcherBudgetKey = keyof typeof WATCHER_BUDGET_LIMITS;

const budget = (key: WatcherBudgetKey) => z.number().int()
  .min(WATCHER_BUDGET_LIMITS[key].min)
  .max(WATCHER_BUDGET_LIMITS[key].max);

export const watcherBudgetsSchema = z.strictObject({
  wakesPerWatchedTurn: budget("wakesPerWatchedTurn"),
  cooldownSeconds: budget("cooldownSeconds"),
  digestKiB: budget("digestKiB"),
  contextReadsPerWake: budget("contextReadsPerWake"),
});

export const watcherLabelSchema = z.string()
  .trim()
  .min(1)
  .max(MAX_WATCHER_LABEL_CHARS)
  .refine(singleLine, "Watcher labels must stay on one line.");

/** Denormalized attribution on a forwarded note; never an execution authority. */
export const watcherNoteAttributionSchema = z.strictObject({
  linkId: z.uuid(),
  wakeId: z.uuid(),
  watcherConversationId: z.uuid(),
  preset: watcherPresetSchema,
  watcherLabel: watcherLabelSchema,
  delivery: watcherDeliveryModeSchema,
});

export const watcherFeedHeadlineSchema = z.strictObject({
  outcome: watcherWakeOutcomeSchema,
  at: timestampSchema,
  text: z.string().max(MAX_WATCHER_HEADLINE_CHARS).refine(watcherPrintableLine, "Watcher headlines stay on one printable line."),
});

export const watcherCountersSchema = z.strictObject({
  wakesThisTurn: countSchema,
  wakeAllowance: countSchema,
  wakesTotal: countSchema,
  eventsSeen: countSchema,
  eventsPending: countSchema,
});

export const watcherLinkViewSchema = z.strictObject({
  id: z.uuid(),
  watcherConversationId: z.uuid(),
  watchedConversationId: z.uuid().nullable(),
  projectId: z.uuid(),
  preset: watcherPresetSchema,
  /**
   * Present only on `watcher.link` command results. The shell projection
   * (`AppSnapshot.watchers` and `watcher.link.updated`) leaves it out so eight
   * links always fit `MAX_WATCHER_LINKS_SERIALIZED_BYTES`.
   */
  instructions: watcherInstructionsSchema.optional(),
  sharing: watcherSharingSchema,
  budgets: watcherBudgetsSchema,
  privateConnect: watcherPrivateConnectSchema,
  delivery: watcherDeliveryPolicySchema,
  status: watcherStatusSchema,
  pauseReason: watcherPauseReasonSchema.nullable(),
  pauseDetail: z.string().max(MAX_WATCHER_PAUSE_DETAIL_CHARS)
    .refine(watcherPrintableLine, "Watcher pause details stay on one printable line.").nullable(),
  detachedReason: watcherDetachReasonSchema.nullable(),
  watchedTurnId: turnIdSchema.nullable(),
  counters: watcherCountersSchema,
  lastWakeAt: timestampSchema.nullable(),
  quietSince: timestampSchema.nullable(),
  feedRevision: countSchema,
  latest: watcherFeedHeadlineSchema.nullable(),
  /** Settlement time of the newest finding that was not dismissed, whatever later checks reported. */
  latestFindingAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).superRefine((link, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  if ((link.status === "paused") !== (link.pauseReason !== null)) issue("Only paused watchers carry a pause reason.");
  if (link.pauseDetail !== null && link.status !== "paused") issue("Only paused watchers carry a pause detail.");
  if ((link.status === "detached") !== (link.detachedReason !== null)) issue("Only detached watchers carry a detach reason.");
  if (link.watchedConversationId === null && link.status !== "detached") issue("An attached watcher needs a watched chat.");
  if (link.watchedConversationId === link.watcherConversationId) issue("A watcher cannot watch itself.");
});

export const watcherDeliverySchema = z.strictObject({
  mode: watcherDeliveryModeSchema.nullable(),
  state: watcherDeliveryStateSchema,
  detail: z.string().max(MAX_WATCHER_DELIVERY_DETAIL_CHARS).nullable(),
  at: timestampSchema,
}).refine(
  (delivery) => (delivery.mode === null) === (delivery.state === "dismissed"),
  "Only dismissed findings have no delivery mode.",
);

export const watcherFeedItemSchema = z.strictObject({
  wakeId: z.uuid(),
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  watcherTurnId: turnIdSchema.nullable(),
  watchedTurnId: turnIdSchema.nullable(),
  trigger: watcherWakeTriggerSchema,
  outcome: watcherWakeOutcomeSchema.nullable(),
  state: watcherWakeStateSchema,
  eventsCovered: countSchema,
  itemsTruncated: countSchema,
  itemsOmitted: countSchema,
  guardState: watcherGuardStateSchema.nullable(),
  guardPaths: z.array(z.string().min(1).max(4_096)).max(MAX_WATCHER_GUARD_PATHS),
  finding: z.string().refine((value) => utf8Bytes(value) <= MAX_WATCHER_FINDING_BYTES).nullable(),
  delivery: watcherDeliverySchema.nullable(),
  createdAt: timestampSchema,
  settledAt: timestampSchema.nullable(),
  /** Read-only commands the watcher ran during this check; omitted when none. */
  commandsRun: z.number().int().min(1).max(10_000).optional(),
}).superRefine((item, context) => {
  const settled = item.state === "settled";
  if (settled !== (item.outcome !== null) || settled !== (item.settledAt !== null)) {
    context.addIssue({ code: "custom", message: "Only settled checks carry an outcome and settlement time." });
  }
  if (item.delivery !== null && item.finding === null) {
    context.addIssue({ code: "custom", message: "Only findings can be delivered or dismissed." });
  }
});

export const watcherWakeSummarySchema = z.strictObject({
  wakeId: z.uuid(),
  turnId: turnIdSchema,
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  trigger: watcherWakeTriggerSchema,
  outcome: watcherWakeOutcomeSchema.nullable(),
  eventsCovered: countSchema,
  itemsTruncated: countSchema,
  itemsOmitted: countSchema,
  guardState: watcherGuardStateSchema.nullable(),
});

export type WatcherHarnessId = (typeof WATCHER_HARNESS_IDS)[number];
export type WatcherPreset = z.infer<typeof watcherPresetSchema>;
export type WatcherStatus = z.infer<typeof watcherStatusSchema>;
export type WatcherPauseReason = z.infer<typeof watcherPauseReasonSchema>;
export type WatcherDetachReason = z.infer<typeof watcherDetachReasonSchema>;
export type WatcherWakeTrigger = z.infer<typeof watcherWakeTriggerSchema>;
export type WatcherWakeOutcome = z.infer<typeof watcherWakeOutcomeSchema>;
export type WatcherGuardState = z.infer<typeof watcherGuardStateSchema>;
export type WatcherWakeState = z.infer<typeof watcherWakeStateSchema>;
export type WatcherDeliveryMode = z.infer<typeof watcherDeliveryModeSchema>;
export type WatcherDeliveryState = z.infer<typeof watcherDeliveryStateSchema>;
export type WatcherPrivateConnect = z.infer<typeof watcherPrivateConnectSchema>;
export type WatcherDeliveryPolicy = z.infer<typeof watcherDeliveryPolicySchema>;
export type WatcherLivePhase = z.infer<typeof watcherLivePhaseSchema>;
export type WatcherSharing = z.infer<typeof watcherSharingSchema>;
export type WatcherBudgets = z.infer<typeof watcherBudgetsSchema>;
export type WatcherNoteAttribution = z.infer<typeof watcherNoteAttributionSchema>;
export type WatcherFeedHeadline = z.infer<typeof watcherFeedHeadlineSchema>;
export type WatcherCounters = z.infer<typeof watcherCountersSchema>;
export type WatcherLinkView = z.infer<typeof watcherLinkViewSchema>;
export type WatcherDelivery = z.infer<typeof watcherDeliverySchema>;
export type WatcherFeedItem = z.infer<typeof watcherFeedItemSchema>;
export type WatcherWakeSummary = z.infer<typeof watcherWakeSummarySchema>;

export const DEFAULT_WATCHER_SHARING: Readonly<WatcherSharing> = Object.freeze({
  brief: true,
  activities: true,
  changedFiles: true,
  partialReplies: true,
});

export const DEFAULT_WATCHER_BUDGETS: Readonly<WatcherBudgets> = Object.freeze({
  wakesPerWatchedTurn: WATCHER_BUDGET_LIMITS.wakesPerWatchedTurn.default,
  cooldownSeconds: WATCHER_BUDGET_LIMITS.cooldownSeconds.default,
  digestKiB: WATCHER_BUDGET_LIMITS.digestKiB.default,
  contextReadsPerWake: WATCHER_BUDGET_LIMITS.contextReadsPerWake.default,
});

/** Fills missing budgets with defaults and clamps finite values into range. */
export function clampWatcherBudgets(input: Partial<Record<WatcherBudgetKey, unknown>> = {}): WatcherBudgets {
  const clamp = (key: WatcherBudgetKey): number => {
    const limits = WATCHER_BUDGET_LIMITS[key];
    const value = input[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return limits.default;
    return Math.min(limits.max, Math.max(limits.min, Math.trunc(value)));
  };
  return {
    wakesPerWatchedTurn: clamp("wakesPerWatchedTurn"),
    cooldownSeconds: clamp("cooldownSeconds"),
    digestKiB: clamp("digestKiB"),
    contextReadsPerWake: clamp("contextReadsPerWake"),
  };
}

export function watcherHarnessAllowed(harnessId: string): harnessId is WatcherHarnessId {
  return (WATCHER_HARNESS_IDS as readonly string[]).includes(harnessId);
}

export function watcherLinksSerializedBytes(links: readonly WatcherLinkView[]): number {
  return utf8Bytes(JSON.stringify(links));
}
