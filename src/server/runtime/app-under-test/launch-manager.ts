import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import {
  APP_CONSOLE_EVENT_BURST,
  APP_CONSOLE_EVENTS_PER_SECOND,
  APP_LOG_EVENT_INTERVAL_MS,
  APP_WINDOW_EVENT_INTERVAL_MS,
  DEFAULT_APP_LOG_READ_LINES,
  MAX_APP_LABEL_CHARS,
  MAX_APP_LAUNCHES_PER_CONVERSATION,
  MAX_APP_LAUNCHES_PER_RUNTIME,
  MAX_APP_LOG_BYTES,
  MAX_APP_LOG_EVENT_BYTES,
  MAX_APP_LOG_EVENT_LINES,
  MAX_APP_LOG_LINE_BYTES,
  MAX_APP_LOG_LINES,
  MAX_APP_LOG_READ_BYTES,
  MAX_APP_LOG_READ_LINES,
  MAX_APP_IDLE_SESSIONS,
  MAX_APP_RETAINED_LAUNCHES_PER_CONVERSATION,
  MAX_APP_RUNTIME_THUMBNAIL_BYTES,
  MAX_APP_WINDOWS,
  type AppUnderTestEvidence,
  type AppUnderTestEvidenceWithThumbnail,
  type AppUnderTestLaunch,
  type AppUnderTestLaunchKind,
  type AppUnderTestLaunchState,
  type AppUnderTestLogLine,
  type AppUnderTestLogPage,
  type AppUnderTestLogsAppendedEvent,
  type AppUnderTestLogStream,
  type AppUnderTestMutationEvent,
  type AppUnderTestStarter,
  type AppUnderTestWindow,
  type AppUnderTestWindowAccessGate,
  type AppUnderTestWindowsUpdatedEvent,
} from "../../../shared/app-under-test";
import type { ProjectPreferences } from "../../../shared/project-preferences";
import {
  runtimeOwnedProcessInvocation,
  spawnRuntimeOwnedProcess,
} from "../../../node/runtime-owned-processes";
import {
  environmentValue,
  executableCandidates,
  providerEnvironment,
  type ProviderEnvironment,
} from "../../environment";
import {
  createOwnedProcessTreeTermination,
  terminateProcessTreeAndWait,
  type OwnedProcessTreeTermination,
  type ProcessTreeTerminator,
} from "../../process-lifecycle";
import { providerProcessInvocation } from "../../provider/process";
import { restrictedCliEnvironment } from "../../restricted-cli-runner";
import { TailTextBuffer } from "../../tail-text-buffer";
import { AppUnderTestError } from "./errors";
import { AppEvidenceLedger, type AppEvidenceLabelKey } from "./evidence-ledger";
import {
  resolveElectronLaunchTarget,
  type ElectronLaunchTarget,
} from "./electron-target";
import {
  NO_CDP_TRANSPORT,
  type AccessibilityTransportFactory,
  type AppUnderTestEvidenceInput,
  type AppUnderTestPendingDialog,
  type AppUnderTestTransportKind,
  type AppUnderTestTransportStatus,
  type AppUnderTestTurn,
  type AppUnderTestWindowTransport,
  type CdpTransportFactory,
} from "./window-transport";

export type AppUnderTestSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface AppUnderTestWorkspace {
  /** The chat's own workspace folder (its worktree when it has one). */
  root: string;
  /** The project's reviewed actions; the only commands an action launch may run. */
  actions: ProjectPreferences["actions"];
}

export type AppUnderTestRuntimeEvent =
  | AppUnderTestMutationEvent
  | AppUnderTestLogsAppendedEvent
  | AppUnderTestWindowsUpdatedEvent;

/** Privileged switches the runtime may add; never chosen by a model or renderer. */
export type AppUnderTestElectronSwitch = "--no-sandbox";

export interface AppUnderTestLaunchManagerOptions {
  dataDirectory: string;
  /** Throws when the chat no longer exists. */
  workspace(conversationId: string): AppUnderTestWorkspace;
  emit?(event: AppUnderTestRuntimeEvent): void;
  cdpTransports?: CdpTransportFactory;
  /** Native windows of action launches; absent when main's App control broker is unavailable. */
  accessibilityTransports?: AccessibilityTransportFactory;
  /**
   * True while the chat has a live renderer subscriber or an active turn.
   * Accessibility launches poll their windows only then; call watchChanged()
   * when it may have changed. Absent means always watched.
   */
  watched?(conversationId: string): boolean;
  onCleanupUnconfirmed?(): void;
  electronSwitches?: readonly AppUnderTestElectronSwitch[];
  platform?: NodeJS.Platform;
  now?(): Date;
  // Test seams; production callers omit them.
  spawn?: AppUnderTestSpawn;
  terminateProcessTree?: ProcessTreeTerminator;
  sourceEnvironment?(): Promise<ProviderEnvironment>;
  resolveElectron?(root: string, platform: NodeJS.Platform): Promise<ElectronLaunchTarget>;
  resolveActionExecutable?(
    executable: string,
    environment: ProviderEnvironment,
    cwd: string,
  ): Promise<string | null>;
  launchSettleMs?: number;
  stopExitWaitMs?: number;
  actionQueueWaitMs?: number;
}

interface LaunchRecord {
  readonly launchId: string;
  readonly conversationId: string;
  readonly kind: AppUnderTestLaunchKind;
  readonly actionId: string | null;
  readonly label: string;
  readonly startedBy: AppUnderTestStarter;
  readonly startedAt: string;
  readonly logs: TailTextBuffer<AppUnderTestLogStream>;
  state: AppUnderTestLaunchState;
  pid: number | null;
  readyAt: string | null;
  exitedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  cleanupConfirmed: boolean | null;
  failure: string | null;
  child: ChildProcess | null;
  terminate: OwnedProcessTreeTermination | null;
  userDataDir: string | null;
  transport: AppUnderTestWindowTransport | null;
  transportKind: AppUnderTestTransportKind | null;
  /** Epoch milliseconds just before the spawn, the root's start-time identity for App control. */
  spawnedAtMs: number;
  stopRequested: boolean;
  stopping: Promise<boolean> | null;
  settled: Promise<void> | null;
  /** Settles when the launch's latest queued window action has finished. */
  actionTail: Promise<void>;
  publishedLogCursor: number;
  logTimer: NodeJS.Timeout | null;
  publishedWindows: string;
  windowTimer: NodeJS.Timeout | null;
  /** The launch fields whose change publishes a sequenced `launch.updated`. */
  publishedLaunch: string;
  consoleTokens: number;
  consoleRefilledAt: number;
  consoleDropped: number;
  consoleTimer: NodeJS.Timeout | null;
  readonly spawned: Promise<void>;
  readonly exited: Promise<void>;
  markSpawned(): void;
  markExited(): void;
}

interface Session {
  readonly launches: Map<string, LaunchRecord>;
  readonly evidence: AppEvidenceLedger;
  /** Larger is more recent; orders idle sessions for eviction. */
  lastActivity: number;
}

const DEFAULT_LAUNCH_SETTLE_MS = 1_000;
const DEFAULT_STOP_EXIT_WAIT_MS = 5_000;
const ACTION_QUEUE_WAIT_MS = 30_000;
const PROFILE_DIRECTORY = "app-under-test";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
// Display and session variables a desktop app needs to open a window. Nothing
// here carries a credential; provider, cloud and agent tokens stay excluded.
const DISPLAY_ENVIRONMENT_KEYS = [
  "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP", "XDG_DATA_DIRS", "WINDIR", "PROGRAMDATA",
] as const;
const ELECTRON_SWITCHES = new Set<AppUnderTestElectronSwitch>(["--no-sandbox"]);
const UNSAFE_LABEL = /[\u0000-\u001f\u007f-\u009f]|\p{Default_Ignorable_Code_Point}|\p{Zl}|\p{Zp}/gu;

/** The sanitized environment every launch receives. */
export function appUnderTestEnvironment(
  source: NodeJS.ProcessEnv,
  kind: AppUnderTestLaunchKind,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment = restrictedCliEnvironment(source, platform);
  for (const key of DISPLAY_ENVIRONMENT_KEYS) {
    const value = environmentValue(source, key, platform);
    if (value !== undefined) environment[key] = value;
  }
  // An Electron launch reads console, exception and crash events over the
  // debugging pipe; Chromium's own stderr copy would repeat every line. An
  // action may start Electron without that pipe, so it keeps the copy.
  if (kind === "action") environment.ELECTRON_ENABLE_LOGGING = "1";
  environment.ACCESSIBILITY_ENABLED = "1";
  return environment;
}

function safeLabel(value: string): string {
  const label = value.replace(UNSAFE_LABEL, " ").replace(/\s+/gu, " ").trim()
    .slice(0, MAX_APP_LABEL_CHARS).trim();
  return label || "Project action";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true, () => true), delay(ms).then(() => false)]);
}

/** Waits for the queued action ahead; its timer and abort listener never outlive the wait. */
function queueTurn(previous: Promise<void>, ms: number, signal: AbortSignal | undefined): Promise<"ready" | "timeout" | "aborted"> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve("aborted");
      return;
    }
    const finish = (value: "ready" | "timeout" | "aborted"): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = (): void => finish("aborted");
    const timer = setTimeout(() => finish("timeout"), ms);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    previous.then(() => finish("ready"), () => finish("ready"));
  });
}

function abortion(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Re-reads state that another callback may have changed across an await. */
function hasExited(record: { state: AppUnderTestLaunchState }): boolean {
  return record.state === "exited";
}

function publicFailure(error: unknown): AppUnderTestError {
  return error instanceof AppUnderTestError
    ? error
    : new AppUnderTestError("unavailable", "Inertia could not start the app.");
}

/**
 * Owns every process Inertia launched as an "app under test". Each chat has
 * one App session: at most two live launches, plus exited launches kept with
 * their last log lines and exit status until the session is cleared.
 *
 * Invariants:
 * - Processes are spawned without a shell, from a reviewed project action or
 *   the project's own contained Electron binary, with a sanitized environment
 *   and runtime-owned process-tree ownership (journaled for crash recovery).
 * - Stop, chat clear, runtime shutdown and a cancelled launch all terminate
 *   the whole tree and report whether that cleanup was proved.
 * - An Electron launch always uses an isolated, 0700 profile under the
 *   runtime data directory, deleted once its tree is proved gone.
 */
export class AppUnderTestLaunchManager {
  private readonly sessions = new Map<string, Session>();
  private activity = 0;
  private readonly live = new Set<LaunchRecord>();
  private readonly platform: NodeJS.Platform;
  private readonly now: () => Date;
  private readonly spawnProcess: AppUnderTestSpawn;
  private readonly profileRoot: string;
  private profilesReady: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly options: AppUnderTestLaunchManagerOptions) {
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? (() => new Date());
    this.spawnProcess = options.spawn ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
    this.profileRoot = join(options.dataDirectory, PROFILE_DIRECTORY);
    for (const value of options.electronSwitches ?? []) {
      if (!ELECTRON_SWITCHES.has(value)) throw new Error("Unsupported Electron switch.");
    }
  }

  get liveLaunchCount(): number {
    return this.live.size;
  }

  /** The label an approval card names before anything is started. */
  describeTarget(conversationId: string, kind: AppUnderTestLaunchKind, actionId?: string): string {
    let workspace: AppUnderTestWorkspace;
    try {
      workspace = this.options.workspace(conversationId);
    } catch {
      throw new AppUnderTestError("not-found", "This chat is no longer available.");
    }
    if (kind === "electron") return "Electron app";
    const action = workspace.actions.find(({ id }) => id === actionId);
    if (!action) {
      throw new AppUnderTestError(
        "not-found",
        "That project action no longer exists. Ask the user to add it in Project settings.",
      );
    }
    return safeLabel(action.name);
  }

  async launch(input: {
    conversationId: string;
    kind: AppUnderTestLaunchKind;
    actionId?: string;
    startedBy: AppUnderTestStarter;
    signal?: AbortSignal;
  }): Promise<AppUnderTestLaunch> {
    if (this.closed) throw new AppUnderTestError("unavailable", "The runtime is shutting down.");
    if ((input.kind === "action") !== (input.actionId !== undefined)) {
      throw new AppUnderTestError("invalid", "An action launch needs exactly one reviewed project action.");
    }
    if (input.signal?.aborted) throw new AppUnderTestError("cancelled", "The launch was cancelled.");
    const label = this.describeTarget(input.conversationId, input.kind, input.actionId);
    const session = this.session(input.conversationId);
    const liveInChat = [...session.launches.values()].filter((record) => record.state !== "exited").length;
    if (liveInChat >= MAX_APP_LAUNCHES_PER_CONVERSATION) {
      throw new AppUnderTestError(
        "too-large",
        `This chat already has ${MAX_APP_LAUNCHES_PER_CONVERSATION} running launches. Stop one with inertia_app_stop first.`,
      );
    }
    if (this.live.size >= MAX_APP_LAUNCHES_PER_RUNTIME) {
      throw new AppUnderTestError(
        "too-large",
        `Inertia already runs ${MAX_APP_LAUNCHES_PER_RUNTIME} launches across all chats. Stop one first.`,
      );
    }
    const record = this.createRecord(input, label);
    session.launches.set(record.launchId, record);
    this.live.add(record);
    this.pruneRetained(session);
    this.emitLaunch(record);
    try {
      await this.spawnLaunch(record, input.signal);
    } catch (error) {
      const failure = publicFailure(error);
      if (record.child === null) this.failBeforeSpawn(record, failure.message);
      throw failure;
    }
    if (input.signal?.aborted) {
      await this.stop(record.conversationId, record.launchId);
      throw new AppUnderTestError("cancelled", "The launch was cancelled, so Inertia stopped the app.", true);
    }
    return this.view(record);
  }

  status(conversationId: string, launchId?: string): AppUnderTestLaunch[] {
    if (launchId !== undefined) return [this.view(this.record(conversationId, launchId))];
    return [...(this.sessions.get(conversationId)?.launches.values() ?? [])].map((record) => this.view(record));
  }

  logs(
    conversationId: string,
    launchId: string,
    options: { cursor?: number; limit?: number; grep?: string } = {},
  ): AppUnderTestLogPage {
    const record = this.record(conversationId, launchId);
    const read = record.logs.read({
      ...(options.cursor === undefined ? { prefer: "newest" as const } : { after: options.cursor }),
      limit: Math.max(1, Math.min(options.limit ?? DEFAULT_APP_LOG_READ_LINES, MAX_APP_LOG_READ_LINES)),
      maxBytes: MAX_APP_LOG_READ_BYTES,
      ...(options.grep === undefined ? {} : { grep: options.grep }),
    });
    return {
      conversationId,
      launchId,
      lines: read.lines,
      nextCursor: read.nextCursor,
      truncated: read.omitted > 0,
      dropped: read.dropped,
    };
  }

  logTail(conversationId: string, launchId: string, count: number): AppUnderTestLogLine[] {
    return this.record(conversationId, launchId).logs.tail(count);
  }

  windows(conversationId: string): AppUnderTestWindow[] {
    return [...(this.sessions.get(conversationId)?.launches.values() ?? [])]
      .filter((record) => record.state !== "exited")
      .flatMap((record) => this.windowsOf(record))
      .slice(0, MAX_APP_WINDOWS);
  }

  launchWindows(conversationId: string, launchId: string): AppUnderTestWindow[] {
    return this.windowsOf(this.record(conversationId, launchId));
  }

  /** Whether any live launch of this chat has a window transport. */
  hasWindowTransport(conversationId: string): boolean {
    return [...(this.sessions.get(conversationId)?.launches.values() ?? [])]
      .some((record) => record.state !== "exited" && record.transport !== null);
  }

  /** Re-reads polled window lists (accessibility launches) before they are listed, for the asking turn. */
  async refreshWindows(conversationId: string, signal: AbortSignal, turn?: AppUnderTestTurn): Promise<void> {
    const live = [...(this.sessions.get(conversationId)?.launches.values() ?? [])]
      .filter((record) => record.state !== "exited" && record.transport?.refreshWindows);
    await Promise.all(live.map(async (record) => {
      await record.transport!.refreshWindows!(signal, turn).catch(() => undefined);
      this.windowsChanged(record);
    }));
  }

  /** Why a live launch of this chat shows no windows, and how many it keeps protected. */
  transportStatus(conversationId: string): AppUnderTestTransportStatus {
    let unavailable: string | null = null;
    let access: AppUnderTestTransportStatus["access"] = null;
    let protectedApps = 0;
    for (const record of this.sessions.get(conversationId)?.launches.values() ?? []) {
      if (record.state === "exited" || !record.transport?.status) continue;
      const status = record.transport.status();
      unavailable ??= status.unavailable;
      access ??= status.access;
      protectedApps += status.protectedApps;
    }
    return { unavailable, protectedApps, access };
  }

  /**
   * Re-checks who watches the chat's launches (all chats without an id), so
   * accessibility launches start polling for a new subscriber or turn and
   * stop when nobody is left.
   */
  watchChanged(conversationId?: string): void {
    for (const record of this.live) {
      if (conversationId !== undefined && record.conversationId !== conversationId) continue;
      if (record.state === "exited") continue;
      try {
        record.transport?.watchChanged?.();
      } catch {
        // A transport that cannot reschedule keeps serving explicit reads.
      }
    }
  }

  /** Per-turn transport state (foreground grants, which also name their turn) ends with the turn. */
  turnSettled(turnId: string): void {
    for (const record of this.live) record.transport?.turnSettled?.(turnId);
  }

  /** The first window of this chat's live launches that shows an unanswered JavaScript dialog. */
  pendingDialog(conversationId: string): AppUnderTestPendingDialog | null {
    for (const record of this.sessions.get(conversationId)?.launches.values() ?? []) {
      if (record.state === "exited" || !record.transport) continue;
      const pending = record.transport.pendingDialog();
      if (pending) return pending;
    }
    return null;
  }

  /** The live launch that owns `windowId`, with its transport, or null. */
  windowOwner(
    conversationId: string,
    windowId: string,
  ): { launch: AppUnderTestLaunch; transport: AppUnderTestWindowTransport } | null {
    for (const record of this.sessions.get(conversationId)?.launches.values() ?? []) {
      if (record.state === "exited" || !record.transport) continue;
      if (this.windowsOf(record).some((window) => window.windowId === windowId)) {
        return { launch: this.view(record), transport: record.transport };
      }
    }
    return null;
  }

  /** Waits for the first window; false without a transport, on exit, timeout or abort. */
  async waitForReady(
    conversationId: string,
    launchId: string,
    signal: AbortSignal,
    timeoutMs: number,
    turn?: AppUnderTestTurn,
  ): Promise<boolean> {
    const record = this.record(conversationId, launchId);
    if (!record.transport || record.state === "exited") return false;
    const ready = await Promise.race([
      record.transport.waitForWindow(signal, timeoutMs, turn).catch(() => false),
      record.exited.then(() => false),
    ]);
    if (ready) this.windowsChanged(record);
    return ready && !hasExited(record);
  }

  /**
   * Runs one window action at a time per launch. A later action waits for the
   * earlier one at most ACTION_QUEUE_WAIT_MS, or until its call is cancelled,
   * then fails with nothing sent.
   */
  async withAction<T>(
    conversationId: string,
    launchId: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const record = this.record(conversationId, launchId);
    const previous = record.actionTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    record.actionTail = previous.then(() => current);
    try {
      const turn = await queueTurn(previous, this.options.actionQueueWaitMs ?? ACTION_QUEUE_WAIT_MS, signal);
      if (turn === "aborted") {
        throw new AppUnderTestError("cancelled", "The App action was cancelled before anything was sent.");
      }
      if (turn === "timeout") {
        throw new AppUnderTestError(
          "timeout",
          "Another App action is still running for this launch, so nothing was sent. Try again when it finishes.",
        );
      }
      return await operation();
    } finally {
      release();
    }
  }

  appendEvidence(
    conversationId: string,
    launchId: string,
    input: AppUnderTestEvidenceInput,
  ): AppUnderTestEvidence | null {
    const record = this.record(conversationId, launchId);
    return input.kind === "screenshot"
      ? this.evidence(record, "screenshot", input.sentToAgent ? "screenshot-sent" : "screenshot", undefined, input)
      : this.evidence(record, "action", input.action);
  }

  listEvidence(conversationId: string): AppUnderTestEvidenceWithThumbnail[] {
    const session = this.sessions.get(conversationId);
    if (session) this.touch(session);
    return session?.evidence.list(true) ?? [];
  }

  async stop(conversationId: string, launchId: string): Promise<AppUnderTestLaunch> {
    const record = this.record(conversationId, launchId);
    await this.stopRecord(record);
    return this.view(record);
  }

  /**
   * Stops every launch of the chat and forgets its App session. Resolves
   * false while any launch of the chat, including one cleared earlier, has
   * not been proved stopped.
   */
  async clear(conversationId: string): Promise<boolean> {
    const session = this.sessions.get(conversationId);
    if (session) {
      this.sessions.delete(conversationId);
      await Promise.all([...session.launches.values()].map(async (record) => {
        await this.stopRecord(record);
        this.stopTimers(record);
      }));
      session.evidence.clear();
      this.emit({ type: "app-under-test.session.cleared", conversationId });
    }
    return ![...this.live].some((record) => record.conversationId === conversationId);
  }

  /** Runtime shutdown: refuses new launches and stops every live one. */
  async dispose(): Promise<boolean> {
    this.closed = true;
    const results = await Promise.all([...this.sessions.keys()].map((conversationId) => this.clear(conversationId)));
    const orphans = await Promise.all([...this.live].map((record) => this.stopRecord(record)));
    return results.every(Boolean) && orphans.every(Boolean);
  }

  private session(conversationId: string): Session {
    let session = this.sessions.get(conversationId);
    if (!session) {
      session = { launches: new Map(), evidence: new AppEvidenceLedger(this.now), lastActivity: 0 };
      this.sessions.set(conversationId, session);
    }
    this.touch(session);
    return session;
  }

  private touch(session: Session): void {
    this.activity += 1;
    session.lastActivity = this.activity;
  }

  private sessionLive(session: Session): boolean {
    return [...session.launches.values()].some((record) => record.state !== "exited" || this.live.has(record));
  }

  /**
   * Keeps at most MAX_APP_IDLE_SESSIONS sessions without a live launch and
   * MAX_APP_RUNTIME_THUMBNAIL_BYTES of thumbnails across all chats, evicting
   * the least recently used idle sessions. Sessions with a live launch are
   * never evicted; at most eight launches run, each chat keeps at most 2 MiB
   * of thumbnails, so they alone stay within the thumbnail bound.
   */
  private enforceSessionBounds(): void {
    const idle = [...this.sessions]
      .filter(([, session]) => !this.sessionLive(session))
      .sort(([, left], [, right]) => left.lastActivity - right.lastActivity);
    let thumbnails = [...this.sessions.values()]
      .reduce((total, session) => total + session.evidence.retainedThumbnailBytes, 0);
    let remaining = idle.length;
    for (const [conversationId, session] of idle) {
      if (remaining <= MAX_APP_IDLE_SESSIONS && thumbnails <= MAX_APP_RUNTIME_THUMBNAIL_BYTES) break;
      thumbnails -= session.evidence.retainedThumbnailBytes;
      remaining -= 1;
      this.evict(conversationId, session);
    }
  }

  /** Forgets an idle session: its exited launches, logs and evidence. */
  private evict(conversationId: string, session: Session): void {
    this.sessions.delete(conversationId);
    for (const record of session.launches.values()) this.stopTimers(record);
    session.evidence.clear();
    this.emit({ type: "app-under-test.session.cleared", conversationId });
  }

  private stopTimers(record: LaunchRecord): void {
    for (const key of ["logTimer", "windowTimer", "consoleTimer"] as const) {
      const timer = record[key];
      if (timer) clearTimeout(timer);
      record[key] = null;
    }
  }

  private record(conversationId: string, launchId: string): LaunchRecord {
    const session = this.sessions.get(conversationId);
    const record = session?.launches.get(launchId);
    if (session && record) this.touch(session);
    if (!record) {
      throw new AppUnderTestError(
        "not-found",
        "That launch does not belong to this chat or was cleared. Call inertia_app_status for current launches.",
      );
    }
    return record;
  }

  private createRecord(
    input: { conversationId: string; kind: AppUnderTestLaunchKind; actionId?: string; startedBy: AppUnderTestStarter },
    label: string,
  ): LaunchRecord {
    let markSpawned!: () => void;
    let markExited!: () => void;
    const spawned = new Promise<void>((resolve) => { markSpawned = resolve; });
    const exited = new Promise<void>((resolve) => { markExited = resolve; });
    // Every committed line, stdout and stderr included, hides the secrets the
    // launch's windows revealed so far.
    const redact = (text: string, cut: boolean): string => record.transport?.redactLog(text, cut) ?? text;
    const record: LaunchRecord = {
      launchId: randomUUID(),
      conversationId: input.conversationId,
      kind: input.kind,
      actionId: input.actionId ?? null,
      label,
      startedBy: input.startedBy,
      startedAt: this.now().toISOString(),
      logs: new TailTextBuffer<AppUnderTestLogStream>({
        maxBytes: MAX_APP_LOG_BYTES,
        maxLines: MAX_APP_LOG_LINES,
        maxLineBytes: MAX_APP_LOG_LINE_BYTES,
        redact,
      }),
      state: "starting",
      pid: null,
      readyAt: null,
      exitedAt: null,
      exitCode: null,
      signal: null,
      cleanupConfirmed: null,
      failure: null,
      child: null,
      terminate: null,
      userDataDir: null,
      transport: null,
      transportKind: null,
      spawnedAtMs: 0,
      stopRequested: false,
      stopping: null,
      settled: null,
      actionTail: Promise.resolve(),
      publishedLogCursor: 0,
      logTimer: null,
      publishedWindows: "[]",
      windowTimer: null,
      publishedLaunch: "",
      consoleTokens: APP_CONSOLE_EVENT_BURST,
      consoleRefilledAt: this.now().getTime(),
      consoleDropped: 0,
      consoleTimer: null,
      spawned,
      exited,
      markSpawned,
      markExited,
    };
    return record;
  }

  private async spawnLaunch(record: LaunchRecord, signal: AbortSignal | undefined): Promise<void> {
    const cancelled = (): void => {
      if (signal?.aborted || record.stopRequested) {
        throw new AppUnderTestError("cancelled", "The launch was cancelled before the app started.");
      }
    };
    const workspace = this.options.workspace(record.conversationId);
    const source = await (this.options.sourceEnvironment ?? (() => providerEnvironment()))();
    cancelled();
    const environment = appUnderTestEnvironment(source.env, record.kind, this.platform);
    let command: string;
    let args: string[];
    let cwd: string;
    let windowsVerbatimArguments: boolean | undefined;
    if (record.kind === "electron") {
      const target = await (this.options.resolveElectron ?? resolveElectronLaunchTarget)(workspace.root, this.platform);
      cancelled();
      record.userDataDir = await this.createProfile(record.launchId);
      cancelled();
      command = target.executable;
      args = [
        ...(this.options.electronSwitches ?? []),
        "--remote-debugging-pipe",
        `--user-data-dir=${record.userDataDir}`,
        target.appPath,
      ];
      cwd = target.root;
    } else {
      const action = workspace.actions.find(({ id }) => id === record.actionId);
      if (!action) {
        throw new AppUnderTestError("not-found", "That project action no longer exists. Ask the user to add it in Project settings.");
      }
      const executable = await (this.options.resolveActionExecutable
        ?? (async (name, env, directory) => (await executableCandidates(name, env, directory, this.platform))[0] ?? null))(
        action.executable, source, workspace.root,
      );
      cancelled();
      if (!executable) {
        throw new AppUnderTestError(
          "not-found",
          "The project action executable was not found. Ask the user to check its path in Project settings.",
        );
      }
      // The same reviewed helper the workspace "Run action" path uses
      // (workspace-run-controller.ts): no shell option; a Windows .cmd/.bat
      // shim alone goes through cmd.exe with one fully quoted, escaped
      // command line and delayed expansion off, so arguments stay data.
      const invocation = providerProcessInvocation(executable, action.args, environment, this.platform);
      command = invocation.command;
      args = invocation.args;
      windowsVerbatimArguments = invocation.windowsVerbatimArguments;
      cwd = workspace.root;
    }
    if (this.closed) throw new AppUnderTestError("unavailable", "The runtime is shutting down.");
    const owned = runtimeOwnedProcessInvocation(command, args);
    record.spawnedAtMs = Date.now();
    let child: ChildProcess;
    try {
      child = spawnRuntimeOwnedProcess(() => this.spawnProcess(owned.command, owned.args, {
        cwd,
        env: environment,
        shell: false,
        detached: this.platform !== "win32",
        // A hidden start would also hide a GUI app's first window on Windows.
        windowsHide: record.kind === "action",
        ...(windowsVerbatimArguments ? { windowsVerbatimArguments } : {}),
        stdio: record.kind === "electron"
          ? ["ignore", "pipe", "pipe", "pipe", "pipe"]
          : ["ignore", "pipe", "pipe"],
      }));
    } catch {
      throw new AppUnderTestError("unavailable", "Inertia could not start the app.");
    }
    this.attach(record, child);
    const aborted = abortion(signal);
    await settledWithin(Promise.race([record.spawned, aborted]), 10_000);
    // A short settle catches an app that exits at once, so the result says so.
    await settledWithin(Promise.race([record.exited, aborted]), this.options.launchSettleMs ?? DEFAULT_LAUNCH_SETTLE_MS);
  }

  private attach(record: LaunchRecord, child: ChildProcess): void {
    record.child = child;
    record.pid = child.pid ?? null;
    record.terminate = createOwnedProcessTreeTermination(
      child,
      "The app under test process tree",
      this.options.terminateProcessTree ?? terminateProcessTreeAndWait,
    );
    const decoders = new Map<"stdout" | "stderr", StringDecoder>();
    for (const stream of ["stdout", "stderr"] as const) {
      const decoder = new StringDecoder("utf8");
      decoders.set(stream, decoder);
      const readable = child[stream];
      readable?.on("error", () => undefined);
      readable?.on("data", (chunk: Buffer | string) => {
        record.logs.append(stream, typeof chunk === "string" ? chunk : decoder.write(chunk));
        this.scheduleLogEvent(record);
      });
    }
    child.once("spawn", () => {
      if (record.state === "starting") {
        record.state = "running";
        this.emitLaunch(record);
      }
      record.markSpawned();
    });
    child.on("error", () => {
      // A spawn failure has no pid and never emits exit; any later error is
      // followed by exit/close, which own the terminal state.
      if (record.pid !== null || record.state === "exited") return;
      record.failure = "The app could not be started. Check that the executable exists and can run.";
      this.onExit(record, null, null);
    });
    child.once("exit", (code, signal) => this.onExit(record, code, signal));
    child.once("close", () => {
      for (const [stream, decoder] of decoders) {
        const rest = decoder.end();
        if (rest) record.logs.append(stream, rest);
      }
      record.logs.flush();
      this.scheduleLogEvent(record);
    });
    this.log(record, record.startedBy === "agent" ? "Launched by the agent." : "Launched by the user.");
    this.evidence(record, "launch", record.startedBy === "agent" ? "launch-agent" : "launch-user");
    if (record.kind === "electron" && record.pid !== null) {
      const input = child.stdio[3];
      const output = child.stdio[4];
      if (input && output && "write" in input && "read" in output) {
        record.transport = (this.options.cdpTransports ?? NO_CDP_TRANSPORT).create({
          launchId: record.launchId,
          conversationId: record.conversationId,
          pid: record.pid,
          input: input as Writable,
          output: output as Readable,
          log: (stream, text) => {
            if (record.state === "exited") return;
            if (stream !== "crash" && !this.takeConsoleToken(record)) return;
            record.logs.appendLine(stream, text);
            this.scheduleLogEvent(record);
          },
          evidence: (entry) => (record.state === "exited" ? null : this.appendEvidenceFor(record, entry)),
          windowsChanged: () => this.windowsChanged(record),
        });
        record.transportKind = record.transport ? "cdp" : null;
      }
    } else if (record.kind === "action" && record.pid !== null && this.options.accessibilityTransports) {
      // An action has no debugging pipe: its native windows go through main's App control.
      record.transport = this.options.accessibilityTransports.create({
        launchId: record.launchId,
        conversationId: record.conversationId,
        pid: record.pid,
        processStartedAt: record.spawnedAtMs,
        evidence: (entry) => (record.state === "exited" ? null : this.appendEvidenceFor(record, entry)),
        windowsChanged: () => this.windowsChanged(record),
        watched: () => this.options.watched?.(record.conversationId) ?? true,
      });
      record.transportKind = record.transport ? "accessibility" : null;
    }
    this.emitLaunch(record);
  }

  private appendEvidenceFor(record: LaunchRecord, entry: AppUnderTestEvidenceInput): string | null {
    const appended = entry.kind === "screenshot"
      ? this.evidence(record, "screenshot", entry.sentToAgent ? "screenshot-sent" : "screenshot", undefined, entry)
      : this.evidence(record, "action", entry.action);
    return appended?.evidenceId ?? null;
  }

  private onExit(record: LaunchRecord, code: number | null, signal: NodeJS.Signals | null): void {
    if (record.state === "exited") return;
    record.state = "exited";
    record.exitCode = code;
    record.signal = signal;
    record.exitedAt = this.now().toISOString();
    this.log(record, record.stopRequested
      ? "Stopped by Inertia."
      : record.failure
        ? "Could not start."
        : code !== null
          ? `Exited with code ${code}.`
          : `Exited after signal ${signal ?? "unknown"}.`);
    this.evidence(
      record,
      "exit",
      record.stopRequested ? "exit-stopped" : record.failure ? "exit-failed" : "exit-code",
      record.stopRequested || record.failure ? undefined : code !== null ? `with code ${code}` : `after ${signal ?? "a signal"}`,
    );
    this.flushDroppedConsole(record);
    record.transport?.close();
    this.windowsChanged(record);
    this.live.delete(record);
    record.markSpawned();
    record.markExited();
    this.emitLaunch(record);
    const session = this.sessions.get(record.conversationId);
    if (session?.launches.has(record.launchId)) this.touch(session);
    this.enforceSessionBounds();
    void this.settle(record).catch(() => undefined);
  }

  /** A token bucket per launch for console, exception and Chromium log events. */
  private takeConsoleToken(record: LaunchRecord): boolean {
    const now = this.now().getTime();
    const elapsed = Math.max(0, now - record.consoleRefilledAt);
    record.consoleTokens = Math.min(
      APP_CONSOLE_EVENT_BURST,
      record.consoleTokens + elapsed * APP_CONSOLE_EVENTS_PER_SECOND / 1_000,
    );
    record.consoleRefilledAt = now;
    if (record.consoleTokens >= 1) {
      record.consoleTokens -= 1;
      return true;
    }
    record.consoleDropped += 1;
    // At most one marker line per second says how many were dropped.
    if (!record.consoleTimer) {
      record.consoleTimer = setTimeout(() => {
        record.consoleTimer = null;
        this.flushDroppedConsole(record);
      }, 1_000);
      record.consoleTimer.unref();
    }
    return false;
  }

  private flushDroppedConsole(record: LaunchRecord): void {
    if (record.consoleTimer) clearTimeout(record.consoleTimer);
    record.consoleTimer = null;
    const dropped = record.consoleDropped;
    if (dropped === 0) return;
    record.consoleDropped = 0;
    this.log(record, `${dropped} console ${dropped === 1 ? "event" : "events"} dropped.`);
  }

  private failBeforeSpawn(record: LaunchRecord, message: string): void {
    record.failure = message.slice(0, 300);
    record.cleanupConfirmed = true;
    this.onExit(record, null, null);
  }

  /** Proves the tree is gone after exit, then removes the isolated profile. */
  private settle(record: LaunchRecord): Promise<void> {
    record.settled ??= (async () => {
      let confirmed = true;
      if (record.terminate) {
        try {
          await record.terminate(true);
        } catch {
          confirmed = false;
        }
      }
      record.cleanupConfirmed = confirmed;
      if (!confirmed) this.options.onCleanupUnconfirmed?.();
      if (confirmed) await this.removeProfile(record);
      this.emitLaunch(record);
    })();
    return record.settled;
  }

  private stopRecord(record: LaunchRecord): Promise<boolean> {
    record.stopping ??= (async () => {
      if (record.state !== "exited") {
        record.stopRequested = true;
        record.state = "stopping";
        this.emitLaunch(record);
        await record.spawned;
        if (record.terminate && !hasExited(record)) {
          try {
            await record.terminate(false);
          } catch {
            // settle() records the unconfirmed cleanup below.
          }
          await settledWithin(record.exited, this.options.stopExitWaitMs ?? DEFAULT_STOP_EXIT_WAIT_MS);
        }
      }
      if (!hasExited(record)) {
        // The process never reported exit: keep it counted as live.
        record.cleanupConfirmed = false;
        record.failure = "Inertia could not confirm that the app stopped.";
        this.options.onCleanupUnconfirmed?.();
        this.emitLaunch(record);
        return false;
      }
      await this.settle(record);
      return record.cleanupConfirmed === true;
    })();
    return record.stopping;
  }

  private pruneRetained(session: Session): void {
    for (const [launchId, record] of session.launches) {
      if (session.launches.size <= MAX_APP_RETAINED_LAUNCHES_PER_CONVERSATION) break;
      // Live launches never exceed the per-chat limit, so dropping the oldest
      // exited ones always restores the bound; their cleanup still completes.
      if (record.state === "exited") {
        this.stopTimers(record);
        session.launches.delete(launchId);
      }
    }
  }

  private windowsOf(record: LaunchRecord): AppUnderTestWindow[] {
    if (!record.transport || record.state === "exited") return [];
    return record.transport.windows()
      .filter((window) => window.launchId === record.launchId)
      .slice(0, MAX_APP_WINDOWS)
      .map((window) => ({ ...window }));
  }

  /**
   * Window changes are live data: at most one `windows.updated` per launch
   * every APP_WINDOW_EVENT_INTERVAL_MS, and only when the bounded list
   * changed. They never enter the sequenced replay log.
   */
  private windowsChanged(record: LaunchRecord): void {
    if (record.readyAt === null && this.windowsOf(record).length > 0) {
      record.readyAt = this.now().toISOString();
      this.evidence(record, "ready", "ready");
    }
    // A protected-window count or a gate is launch state: republished only when it changed.
    if (record.transportKind === "accessibility") this.emitLaunch(record);
    if (record.windowTimer || !this.options.emit) return;
    record.windowTimer = setTimeout(() => {
      record.windowTimer = null;
      this.publishWindows(record);
    }, APP_WINDOW_EVENT_INTERVAL_MS);
    record.windowTimer.unref();
  }

  private publishWindows(record: LaunchRecord): void {
    if (!this.sessions.get(record.conversationId)?.launches.has(record.launchId)) return;
    const windows = this.windowsOf(record);
    const key = JSON.stringify(windows);
    if (key === record.publishedWindows) return;
    record.publishedWindows = key;
    this.emit({
      type: "app-under-test.windows.updated",
      conversationId: record.conversationId,
      launchId: record.launchId,
      windows,
    });
  }

  private log(record: LaunchRecord, text: string): void {
    record.logs.appendLine("inertia", text);
    this.scheduleLogEvent(record);
  }

  private evidence(
    record: LaunchRecord,
    kind: AppUnderTestEvidence["kind"],
    label: AppEvidenceLabelKey,
    detail?: string,
    screenshot?: { png: Uint8Array; width: number; height: number },
  ): AppUnderTestEvidence | null {
    const session = this.sessions.get(record.conversationId);
    if (!session?.launches.has(record.launchId)) return null;
    const appended = session.evidence.append({
      launchId: record.launchId,
      kind,
      label,
      ...(detail ? { detail } : {}),
      ...(screenshot ? { png: screenshot.png, width: screenshot.width, height: screenshot.height } : {}),
    });
    if (appended) {
      this.emit({
        type: "app-under-test.evidence.appended",
        conversationId: record.conversationId,
        evidence: appended,
      });
      if (appended.hasThumbnail) this.enforceSessionBounds();
    }
    return appended;
  }

  private scheduleLogEvent(record: LaunchRecord): void {
    if (record.logTimer || !this.options.emit) return;
    record.logTimer = setTimeout(() => {
      record.logTimer = null;
      this.publishLogs(record);
    }, APP_LOG_EVENT_INTERVAL_MS);
    record.logTimer.unref();
  }

  private publishLogs(record: LaunchRecord): void {
    if (!this.sessions.get(record.conversationId)?.launches.has(record.launchId)) return;
    const read = record.logs.read({
      after: record.publishedLogCursor,
      limit: MAX_APP_LOG_EVENT_LINES,
      maxBytes: MAX_APP_LOG_EVENT_BYTES,
      prefer: "newest",
    });
    record.publishedLogCursor = read.nextCursor;
    if (read.lines.length === 0) return;
    this.emit({
      type: "app-under-test.logs.appended",
      conversationId: record.conversationId,
      launchId: record.launchId,
      lines: read.lines,
      dropped: read.dropped + read.omitted,
    });
  }

  /**
   * Publishes one event. A failing subscriber must not interrupt the child
   * process callbacks, the launch bookkeeping or a cleanup proof that called it.
   */
  private emit(event: AppUnderTestRuntimeEvent): void {
    try {
      this.options.emit?.(event);
    } catch {
      // The App surface rereads authoritative state on its next load.
    }
  }

  /**
   * Publishes a sequenced `launch.updated` only when the launch's state,
   * process, exit, stop request or cleanup changed; it carries the windows of
   * that moment. Window changes alone go out as live `windows.updated`.
   */
  private emitLaunch(record: LaunchRecord): void {
    if (!this.sessions.get(record.conversationId)?.launches.has(record.launchId)) return;
    const key = JSON.stringify([
      record.state, record.pid, record.exitedAt, record.exitCode, record.signal, record.stopRequested,
      record.cleanupConfirmed, record.failure, record.transport !== null, record.transportKind,
      ...this.accessFields(record),
    ]);
    if (key === record.publishedLaunch) return;
    record.publishedLaunch = key;
    this.emit({
      type: "app-under-test.launch.updated",
      conversationId: record.conversationId,
      launch: this.view(record),
    });
  }

  private view(record: LaunchRecord): AppUnderTestLaunch {
    const windows = this.windowsOf(record);
    const access = record.transport && record.transportKind === "accessibility" ? this.accessFields(record) : null;
    return {
      launchId: record.launchId,
      conversationId: record.conversationId,
      kind: record.kind,
      actionId: record.actionId,
      label: record.label,
      startedBy: record.startedBy,
      state: record.state,
      pid: record.pid,
      startedAt: record.startedAt,
      readyAt: record.readyAt,
      exitedAt: record.exitedAt,
      exitCode: record.exitCode,
      signal: record.signal,
      stopRequested: record.stopRequested,
      cdp: record.transport !== null && record.transportKind === "cdp",
      transport: record.transport ? record.transportKind : null,
      ...(access ? { protectedApps: access[0], windowAccess: access[1] } : {}),
      windowCount: windows.length,
      windows,
      cleanupConfirmed: record.cleanupConfirmed,
      failure: record.failure,
    };
  }

  /** An accessibility launch's protected-app count and gate while it runs. */
  private accessFields(record: LaunchRecord): [number, AppUnderTestWindowAccessGate | null] {
    if (record.transportKind !== "accessibility" || !record.transport?.status || record.state === "exited") return [0, null];
    const status = record.transport.status();
    return [Math.min(Math.max(0, status.protectedApps), 64), status.access];
  }

  private async ensureProfileRoot(): Promise<void> {
    this.profilesReady ??= (async () => {
      await mkdir(this.profileRoot, { recursive: true, mode: 0o700 });
      const info = await lstat(this.profileRoot);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new AppUnderTestError("unavailable", "The isolated app profile folder is unavailable.");
      }
      if (this.platform !== "win32") await chmod(this.profileRoot, 0o700);
      // Profiles left by a runtime that crashed: their process trees were
      // already reclaimed from the ownership journal before this runtime ran.
      const active = new Set([...this.live].map(({ launchId }) => launchId));
      for (const entry of await readdir(this.profileRoot, { withFileTypes: true })) {
        if (!UUID.test(entry.name) || active.has(entry.name)) continue;
        await rm(join(this.profileRoot, entry.name), { recursive: true, force: true, maxRetries: 2 })
          .catch(() => undefined);
      }
    })();
    try {
      await this.profilesReady;
    } catch (error) {
      this.profilesReady = null;
      throw error instanceof AppUnderTestError
        ? error
        : new AppUnderTestError("unavailable", "The isolated app profile folder is unavailable.");
    }
  }

  private async createProfile(launchId: string): Promise<string> {
    await this.ensureProfileRoot();
    const directory = join(this.profileRoot, launchId);
    try {
      await mkdir(directory, { mode: 0o700 });
      if (this.platform !== "win32") await chmod(directory, 0o700);
    } catch {
      throw new AppUnderTestError("unavailable", "The isolated app profile folder is unavailable.");
    }
    return directory;
  }

  private async removeProfile(record: LaunchRecord): Promise<void> {
    const directory = record.userDataDir;
    if (!directory) return;
    record.userDataDir = null;
    await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
}
