import { z } from "zod";

import { MAX_PROVIDER_HOST_TOOL_RESULT_BYTES } from "./provider-host-tools";

/**
 * Provider-neutral contract for the "App under test" surface: processes that
 * Inertia launched for one chat, their logs, windows and local evidence.
 * Nothing here names a provider, a CDP method or a filesystem path.
 */

export const APP_UNDER_TEST_PACK_ID = "inertia.app-under-test";
export const APP_UNDER_TEST_PACK_REVISION = 1;

export const APP_UNDER_TEST_LAUNCH_KINDS = ["electron", "action"] as const;
export type AppUnderTestLaunchKind = (typeof APP_UNDER_TEST_LAUNCH_KINDS)[number];

export const APP_UNDER_TEST_LAUNCH_STATES = ["starting", "running", "stopping", "exited"] as const;
export type AppUnderTestLaunchState = (typeof APP_UNDER_TEST_LAUNCH_STATES)[number];

export const APP_UNDER_TEST_STARTERS = ["agent", "user"] as const;
export type AppUnderTestStarter = (typeof APP_UNDER_TEST_STARTERS)[number];

/** `inertia` lines are Inertia's own fixed-wording notes (launch, exit). */
export const APP_UNDER_TEST_LOG_STREAMS = ["stdout", "stderr", "console", "exception", "crash", "inertia"] as const;
export type AppUnderTestLogStream = (typeof APP_UNDER_TEST_LOG_STREAMS)[number];

export const APP_UNDER_TEST_EVIDENCE_KINDS = ["launch", "ready", "exit", "action", "screenshot"] as const;
export type AppUnderTestEvidenceKind = (typeof APP_UNDER_TEST_EVIDENCE_KINDS)[number];

export const APP_UNDER_TEST_TOOL_NAMES = [
  "inertia_app_launch",
  "inertia_app_status",
  "inertia_app_logs",
  "inertia_app_stop",
  "inertia_app_windows",
  "inertia_app_snapshot",
  "inertia_app_click",
  "inertia_app_type",
  "inertia_app_press",
  "inertia_app_scroll",
  "inertia_app_wait_for",
  "inertia_app_screenshot",
] as const;
export type AppUnderTestToolName = (typeof APP_UNDER_TEST_TOOL_NAMES)[number];

export const APP_UNDER_TEST_ERROR_CODES = [
  "invalid",
  "not-found",
  "unavailable",
  "timeout",
  "too-large",
  "cancelled",
  "approval_expired",
  "sensitive",
  "user_denied",
  "call_cancelled",
  "unknown_tool",
  "invalid_owner",
] as const;
export type AppUnderTestErrorCode = (typeof APP_UNDER_TEST_ERROR_CODES)[number];
export const APP_UNDER_TEST_RETRYABLE_ERROR_CODES: ReadonlySet<AppUnderTestErrorCode> = new Set([
  "not-found",
  "unavailable",
  "timeout",
  "too-large",
  "approval_expired",
]);

// Bounds. Every collection the runtime keeps or returns is limited here.
export const MAX_APP_LAUNCHES_PER_CONVERSATION = 2;
export const MAX_APP_LAUNCHES_PER_RUNTIME = 8;
/** Exited launches a chat keeps (with logs and exit status) until it is cleared. */
export const MAX_APP_RETAINED_LAUNCHES_PER_CONVERSATION = 8;
export const MAX_APP_LOG_BYTES = 64 * 1024;
export const MAX_APP_LOG_LINES = 2_000;
export const MAX_APP_LOG_LINE_BYTES = 4 * 1024;
export const MAX_APP_LOG_READ_BYTES = 4 * 1024;
export const MAX_APP_LOG_READ_LINES = 200;
export const DEFAULT_APP_LOG_READ_LINES = 100;
export const MAX_APP_LOG_GREP_CHARS = 200;
export const APP_LAUNCH_LOG_TAIL_LINES = 20;
export const MAX_APP_LOG_EVENT_LINES = 64;
export const MAX_APP_LOG_EVENT_BYTES = 8 * 1024;
export const APP_LOG_EVENT_INTERVAL_MS = 250;
/** Window lists reach subscribed surfaces at most this often, and only when they changed. */
export const APP_WINDOW_EVENT_INTERVAL_MS = 500;
/** Console, exception and Chromium log events kept per launch: a token bucket. */
export const APP_CONSOLE_EVENTS_PER_SECOND = 200;
export const APP_CONSOLE_EVENT_BURST = 400;
export const MAX_APP_WINDOWS = 8;
export const MAX_APP_WINDOW_TITLE_CHARS = 120;
export const MAX_APP_TYPE_CHARS = 4_000;
export const MAX_APP_WAIT_TEXT_CHARS = 200;
export const MIN_APP_WAIT_MS = 100;
export const MAX_APP_WAIT_MS = 30_000;
export const DEFAULT_APP_WAIT_MS = 10_000;
export const MAX_APP_SCROLL_DELTA = 20_000;
export const APP_INSPECT_BUDGET_MS = 20_000;
export const APP_INPUT_BUDGET_MS = 40_000;
export const APP_LAUNCH_READY_MS = 60_000;
export const MAX_APP_PENDING_CDP_REQUESTS = 16;
export const MAX_APP_CDP_FRAME_BYTES = 4 * 1024 * 1024;
export const APP_APPROVAL_EXPIRY_MS = 5 * 60_000;
export const MAX_APP_EVIDENCE_ENTRIES = 100;
export const MAX_APP_EVIDENCE_THUMBNAILS = 8;
export const MAX_APP_EVIDENCE_THUMBNAIL_BYTES = 256 * 1024;
export const MAX_APP_EVIDENCE_THUMBNAIL_TOTAL_BYTES = 2 * 1024 * 1024;
export const MAX_APP_EVIDENCE_THUMBNAIL_WIDTH = 512;
export const MAX_APP_EVIDENCE_THUMBNAIL_HEIGHT = 320;
/** Thumbnails kept across every chat's App session in one runtime. */
export const MAX_APP_RUNTIME_THUMBNAIL_BYTES = 16 * 1024 * 1024;
/** Chat App sessions without a live launch kept in runtime memory (least recently used go first). */
export const MAX_APP_IDLE_SESSIONS = 16;
export const MAX_APP_TOOL_RESULT_BYTES = MAX_PROVIDER_HOST_TOOL_RESULT_BYTES;
export const MAX_APP_LABEL_CHARS = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SINGLE_LINE = /^[^\u0000-\u001f\u007f]*$/u;
const isoDate = z.string().max(64).refine((value) => !Number.isNaN(Date.parse(value)));
const uuid = z.string().regex(UUID);
const label = z.string().min(1).max(MAX_APP_LABEL_CHARS).regex(SINGLE_LINE);

export interface AppUnderTestWindow {
  /** Stable opaque id minted by Inertia; never a raw debugging target id. */
  windowId: string;
  launchId: string;
  /** Sanitized and at most MAX_APP_WINDOW_TITLE_CHARS characters. */
  title: string;
  /** Origin only (scheme, host and port); null for documents without one. */
  origin: string | null;
  active: boolean;
  loading: boolean;
}

export interface AppUnderTestLaunch {
  launchId: string;
  conversationId: string;
  kind: AppUnderTestLaunchKind;
  actionId: string | null;
  /** Fixed wording or the user's own action name; never process output. */
  label: string;
  startedBy: AppUnderTestStarter;
  state: AppUnderTestLaunchState;
  pid: number | null;
  startedAt: string;
  readyAt: string | null;
  exitedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  /**
   * True once Inertia was asked to end the launch (a user or agent stop, the
   * chat's App session being cleared, cancellation or shutdown), so an exit
   * code or signal that follows is the stop, not a crash.
   */
  stopRequested: boolean;
  cdp: boolean;
  windowCount: number;
  /**
   * The launch's current windows (at most MAX_APP_WINDOWS, sanitized) when
   * this record was produced, so a surface opened after the app started knows
   * them at once; the live `windows.updated` event carries later changes.
   */
  windows: AppUnderTestWindow[];
  /** Null until the process tree is gone; false when cleanup could not be proved. */
  cleanupConfirmed: boolean | null;
  /** Fixed-wording reason when the launch could not start or stopped abnormally. */
  failure: string | null;
}

export interface AppUnderTestLogLine {
  /** Monotonically increasing per launch; never reused. */
  cursor: number;
  stream: AppUnderTestLogStream;
  text: string;
}

export interface AppUnderTestEvidence {
  evidenceId: string;
  launchId: string;
  kind: AppUnderTestEvidenceKind;
  /** Fixed wording only; never window titles, typed text or app output. */
  label: string;
  at: string;
  width: number | null;
  height: number | null;
  hasThumbnail: boolean;
}

export interface AppUnderTestEvidenceWithThumbnail extends AppUnderTestEvidence {
  /** `data:image/png;base64,...`, present only in the App surface's list result. */
  thumbnail: string | null;
}

export const appUnderTestWindowSchema = z.object({
  windowId: uuid,
  launchId: uuid,
  title: z.string().max(MAX_APP_WINDOW_TITLE_CHARS).regex(SINGLE_LINE),
  origin: z.string().max(512).regex(SINGLE_LINE).nullable(),
  active: z.boolean(),
  loading: z.boolean(),
}).strict();

export const appUnderTestLaunchSchema = z.object({
  launchId: uuid,
  conversationId: uuid,
  kind: z.enum(APP_UNDER_TEST_LAUNCH_KINDS),
  actionId: uuid.nullable(),
  label,
  startedBy: z.enum(APP_UNDER_TEST_STARTERS),
  state: z.enum(APP_UNDER_TEST_LAUNCH_STATES),
  pid: z.number().int().positive().nullable(),
  startedAt: isoDate,
  readyAt: isoDate.nullable(),
  exitedAt: isoDate.nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.string().max(32).regex(SINGLE_LINE).nullable(),
  stopRequested: z.boolean(),
  cdp: z.boolean(),
  windowCount: z.number().int().min(0).max(MAX_APP_WINDOWS),
  windows: z.array(appUnderTestWindowSchema).max(MAX_APP_WINDOWS),
  cleanupConfirmed: z.boolean().nullable(),
  failure: z.string().max(300).regex(SINGLE_LINE).nullable(),
}).strict().refine(
  (value) => value.windows.length === value.windowCount
    && value.windows.every((window) => window.launchId === value.launchId),
  "A launch lists exactly its own windows.",
);

export const appUnderTestLogLineSchema = z.object({
  cursor: z.number().int().positive(),
  stream: z.enum(APP_UNDER_TEST_LOG_STREAMS),
  // A cut line carries a short marker after its MAX_APP_LOG_LINE_BYTES bytes.
  text: z.string().max(MAX_APP_LOG_LINE_BYTES).refine((value) => !/[\u0000-\u0008\u000a-\u001f\u007f]/u.test(value)),
}).strict();

export const appUnderTestEvidenceSchema = z.object({
  evidenceId: uuid,
  launchId: uuid,
  kind: z.enum(APP_UNDER_TEST_EVIDENCE_KINDS),
  label,
  at: isoDate,
  width: z.number().int().positive().max(16_384).nullable(),
  height: z.number().int().positive().max(16_384).nullable(),
  hasThumbnail: z.boolean(),
}).strict();

const THUMBNAIL_DATA_URL = /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/u;
export const appUnderTestEvidenceWithThumbnailSchema = appUnderTestEvidenceSchema.extend({
  thumbnail: z.string()
    .max(Math.ceil(MAX_APP_EVIDENCE_THUMBNAIL_BYTES / 3) * 4 + "data:image/png;base64,".length)
    .regex(THUMBNAIL_DATA_URL)
    .nullable(),
}).strict();

// Renderer command payloads. The renderer can never pass a command line,
// arguments, a path or an environment: only a kind and a reviewed action id.
export const appUnderTestConversationPayloadSchema = z.object({
  conversationId: uuid,
}).strict();

export const appUnderTestLaunchPayloadSchema = z.object({
  conversationId: uuid,
  kind: z.enum(APP_UNDER_TEST_LAUNCH_KINDS),
  actionId: uuid.optional(),
}).strict().refine(
  (value) => (value.kind === "action") === (value.actionId !== undefined),
  "An action launch needs exactly one reviewed project action; an Electron launch takes none.",
);

export const appUnderTestStopPayloadSchema = z.object({
  conversationId: uuid,
  launchId: uuid,
}).strict();

export const appUnderTestLogReadPayloadSchema = z.object({
  conversationId: uuid,
  launchId: uuid,
  cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.number().int().min(1).max(MAX_APP_LOG_READ_LINES).optional(),
  grep: z.string().min(1).max(MAX_APP_LOG_GREP_CHARS).regex(SINGLE_LINE).optional(),
}).strict();

export const APP_UNDER_TEST_COMMAND_TYPES = [
  "app-under-test.launches.list",
  "app-under-test.launch",
  "app-under-test.stop",
  "app-under-test.logs.read",
  "app-under-test.evidence.list",
] as const;

// Runtime results and events. Launch, evidence and session events are
// sequenced chat-detail mutations; log lines and window lists are unsequenced
// live data sent only to sockets subscribed to that chat, so a noisy app
// cannot evict replay history. A reconnecting renderer rereads the tail with
// `logs.read` and the windows with `launches.list`.
export interface AppUnderTestLogPage {
  conversationId: string;
  launchId: string;
  lines: AppUnderTestLogLine[];
  nextCursor: number;
  truncated: boolean;
  dropped: number;
}

export type AppUnderTestRequestResult =
  | { kind: "app-under-test.launches"; conversationId: string; launches: AppUnderTestLaunch[] }
  | { kind: "app-under-test.launch"; conversationId: string; launch: AppUnderTestLaunch }
  | ({ kind: "app-under-test.logs" } & AppUnderTestLogPage)
  | { kind: "app-under-test.evidence"; conversationId: string; evidence: AppUnderTestEvidenceWithThumbnail[] };

export type AppUnderTestMutationEvent =
  | { type: "app-under-test.launch.updated"; conversationId: string; launch: AppUnderTestLaunch }
  | { type: "app-under-test.evidence.appended"; conversationId: string; evidence: AppUnderTestEvidence }
  | { type: "app-under-test.session.cleared"; conversationId: string };

/** Live only, coalesced and sent only when the launch's bounded window list changed. */
export interface AppUnderTestWindowsUpdatedEvent {
  type: "app-under-test.windows.updated";
  conversationId: string;
  launchId: string;
  windows: AppUnderTestWindow[];
}

export interface AppUnderTestLogsAppendedEvent {
  type: "app-under-test.logs.appended";
  conversationId: string;
  launchId: string;
  lines: AppUnderTestLogLine[];
  /** Lines that were evicted or skipped since the previous event. */
  dropped: number;
}

const logLines = z.array(appUnderTestLogLineSchema).max(MAX_APP_LOG_READ_LINES);

export const appUnderTestRequestResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("app-under-test.launches"),
    conversationId: uuid,
    launches: z.array(appUnderTestLaunchSchema).max(MAX_APP_RETAINED_LAUNCHES_PER_CONVERSATION),
  }).strict(),
  z.object({ kind: z.literal("app-under-test.launch"), conversationId: uuid, launch: appUnderTestLaunchSchema }).strict(),
  z.object({
    kind: z.literal("app-under-test.logs"),
    conversationId: uuid,
    launchId: uuid,
    lines: logLines,
    nextCursor: z.number().int().min(0),
    truncated: z.boolean(),
    dropped: z.number().int().min(0),
  }).strict(),
  z.object({
    kind: z.literal("app-under-test.evidence"),
    conversationId: uuid,
    evidence: z.array(appUnderTestEvidenceWithThumbnailSchema).max(MAX_APP_EVIDENCE_ENTRIES),
  }).strict(),
]);

export const appUnderTestMutationEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("app-under-test.launch.updated"), conversationId: uuid, launch: appUnderTestLaunchSchema }).strict()
    .refine((value) => value.launch.conversationId === value.conversationId),
  z.object({ type: z.literal("app-under-test.evidence.appended"), conversationId: uuid, evidence: appUnderTestEvidenceSchema }).strict(),
  z.object({ type: z.literal("app-under-test.session.cleared"), conversationId: uuid }).strict(),
]);

export const appUnderTestWindowsUpdatedEventSchema = z.object({
  type: z.literal("app-under-test.windows.updated"),
  conversationId: uuid,
  launchId: uuid,
  windows: z.array(appUnderTestWindowSchema).max(MAX_APP_WINDOWS),
}).strict().refine((value) => value.windows.every((window) => window.launchId === value.launchId));

export const appUnderTestLogsAppendedEventSchema = z.object({
  type: z.literal("app-under-test.logs.appended"),
  conversationId: uuid,
  launchId: uuid,
  lines: z.array(appUnderTestLogLineSchema).min(1).max(MAX_APP_LOG_EVENT_LINES),
  dropped: z.number().int().min(0),
}).strict();
