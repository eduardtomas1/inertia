import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, nativeImage, systemPreferences, utilityProcess } from "electron";

import {
  APP_CONTROL_ACTION_WATCHDOG_MS,
  APP_CONTROL_INSPECT_WATCHDOG_MS,
  APP_CONTROL_KILL_CONFIRM_MS,
  APP_CONTROL_MAX_AGENT_IMAGE_EDGE,
  APP_CONTROL_MAX_AGENT_IMAGE_PIXELS,
  APP_CONTROL_MAX_AGENT_PNG_BYTES,
  APP_CONTROL_MAX_PENDING_REQUESTS,
  APP_CONTROL_MAX_PNG_BYTES,
  appControlFailure,
  type AppControlCommand,
  type AppControlFailure,
  type AppControlIdentity,
  type AppControlResult,
  type AppControlValue,
} from "../node/runtime-app-control-protocol.js";
import type { AppControlSettingsState } from "../shared/app-control-settings.js";
import {
  appControlInputAvailable,
  appControlInputUnavailableReason,
  appControlLinuxSession,
  appControlScreenshotAvailable,
} from "./app-control-platform.js";
import {
  appControlOwnedTree,
  AppControlTreeTooLargeError,
  readLinuxProcessTable,
  type AppControlOwnedTree,
  type AppControlProcessEntry,
} from "./app-control-process-tree.js";
import {
  parseAppControlWorkerResponse,
  type AppControlWorkerCommand,
  type AppControlWorkerRequest,
  type AppControlWorkerResult,
} from "./app-control-worker-protocol.js";
import type { AppControlRuntimeParents, RuntimeAppControlMainBroker } from "./runtime-app-control-coordinator.js";
import { snapshotWorkerEnvironment } from "./snapshot-service.js";

/**
 * Main's App control service: the only place native accessibility work for an
 * App under test launch starts. It resolves the launch's owned process tree,
 * checks the root is still the process the runtime spawned, applies the
 * platform and permission gates, and runs one command at a time in the
 * "Inertia App Control" utility worker under a per-command watchdog. A worker
 * that fails natively, times out or crashes is recycled; one whose exit cannot
 * be confirmed, even after a forced kill, disables the service until Inertia
 * restarts. A worker that fails to load three times in a row latches the
 * service off until the Settings card probes it again or Inertia restarts.
 */

export interface AppControlWorkerProcess {
  readonly pid?: number | undefined;
  postMessage(message: AppControlWorkerRequest): void;
  kill(): boolean;
  on(event: "message", listener: (value: unknown) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
}

export interface AppControlThumbnail { png: Uint8Array; width: number; height: number }

export interface AppControlServiceDependencies {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  fork(): AppControlWorkerProcess;
  /** macOS: Inertia is allowed in Accessibility. */
  accessibilityTrusted(): boolean;
  /** macOS: Inertia is allowed in Screen Recording. */
  screenRecordingGranted(): boolean;
  /** Linux process table from `/proc`; Windows and macOS read theirs in the worker. */
  processTable(rootPid: number): Promise<AppControlProcessEntry[]>;
  /** Inertia's own processes, always denied. */
  ownPids(): number[];
  reduceThumbnail(png: Uint8Array): AppControlThumbnail | null;
  /** The model-visible image: long edge at most 1,536 pixels, at most 720,000 pixels, PNG of at most 3.75 MB. */
  reduceAgentImage(png: Uint8Array): AppControlThumbnail | null;
  /** macOS: a fresh private folder for one worker's window captures, removed by `release`. */
  captureFolder?(): { path: string; release(): void } | null;
  /** Forced kill of a worker that ignored the graceful one; defaults to SIGKILL. */
  forceKill?(pid: number): void;
  now?(): number;
  readyTimeoutMs?: number;
  idleMs?: number;
}

interface WorkerSlot {
  child: AppControlWorkerProcess;
  ready: Promise<boolean>;
  exited: boolean;
  /** One exit promise per worker instance; commands wait on it through `exitWaiters`. */
  exit: Promise<void>;
  /** Per-command exit listeners, each removed when its command completes. */
  exitWaiters: Set<() => void>;
  waiting: Map<number, (value: unknown) => void>;
  captureFolder: { path: string; release(): void } | null;
}

interface CachedTree {
  tree: AppControlOwnedTree;
  rootParentPid: number;
  expiresAt: number;
}

const READY_TIMEOUT_MS = 10_000;
const IDLE_MS = 60_000;
const THUMBNAIL_WIDTH = 512;
const THUMBNAIL_HEIGHT = 320;
/** Consecutive workers that never became ready before the service latches off. */
const START_FAILURE_LIMIT = 3;
/** After the graceful kill's grace, how long a forced kill gets to be confirmed. */
const FORCE_KILL_CONFIRM_MS = 2_000;
/** A launch's resolved process tree is reused for this long. */
const TREE_CACHE_MS = 1_000;
const MAX_CACHED_TREES = 32;

/** Commands that may reach the app: accessibility actions and synthesized input. */
function mayReachApp(command: AppControlWorkerCommand): boolean {
  return command.command === "perform" || command.command === "input";
}

function watchdogFor(command: AppControlWorkerCommand): number {
  // Actions, synthesized input and screenshots (which plan, capture and plan again) get the longer watchdog.
  return mayReachApp(command) || command.command === "screenshot"
    ? APP_CONTROL_ACTION_WATCHDOG_MS
    : APP_CONTROL_INSPECT_WATCHDOG_MS;
}

function sigkill(pid: number): void {
  process.kill(pid, "SIGKILL");
}

export class AppControlService implements RuntimeAppControlMainBroker {
  private worker: WorkerSlot | null = null;
  private chain: Promise<void> = Promise.resolve();
  private queued = 0;
  private nextId = 1;
  /** Commands accepted and not yet answered, including their process-tree read. */
  private admitted = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  /** A worker's exit could not be confirmed; nothing more runs until restart. */
  private unconfirmed = false;
  /** Consecutive workers that did not become ready, and whether that latched the service off. */
  private startFailures = 0;
  private startLatched = false;
  private readonly trees = new Map<string, CachedTree>();

  constructor(private readonly dependencies: AppControlServiceDependencies) {}

  get available(): boolean {
    return !this.disposed && !this.unconfirmed;
  }

  /** Per-command listeners still registered on the current worker (tests). */
  get pendingListeners(): number {
    return this.worker ? this.worker.exitWaiters.size + this.worker.waiting.size : 0;
  }

  permissions(): Extract<AppControlValue, { kind: "permissions" }> {
    const { platform } = this.dependencies;
    const mac = platform === "darwin";
    return {
      kind: "permissions",
      accessibility: mac ? (this.dependencies.accessibilityTrusted() ? "granted" : "required") : "unverified",
      screenRecording: mac ? (this.dependencies.screenRecordingGranted() ? "granted" : "required") : "unverified",
      screenshots: appControlScreenshotAvailable(platform, this.dependencies.env) ? "available" : "unavailable",
      input: this.inputState(),
    };
  }

  /** Synthesized key and wheel input: macOS needs Accessibility; Wayland and unknown platforms have none. */
  private inputState(): "available" | "required" | "unavailable" {
    const { platform, env } = this.dependencies;
    if (!this.available || !["darwin", "win32", "linux"].includes(platform) || !appControlInputAvailable(platform, env)) {
      return "unavailable";
    }
    return platform === "darwin" && !this.dependencies.accessibilityTrusted() ? "required" : "available";
  }

  /**
   * The App control card's state. macOS and Linux probe the helper with an
   * empty scope (it lists accessibility applications and reads none of their
   * windows), which tells a working AT-SPI bus from a missing one and a
   * helper denial from a granted Accessibility permission. It never prompts.
   */
  async settingsState(signal: AbortSignal = new AbortController().signal): Promise<AppControlSettingsState> {
    const { platform, env } = this.dependencies;
    const known = platform === "darwin" || platform === "win32" || platform === "linux";
    const linux = platform === "linux";
    const state: AppControlSettingsState = {
      platform: known ? platform : "unsupported",
      available: this.available && known,
      accessibility: platform === "darwin" ? "required" : "unavailable",
      screenRecording: platform === "darwin" ? (this.dependencies.screenRecordingGranted() ? "granted" : "required") : "not-needed",
      screenshots: appControlScreenshotAvailable(platform, env) ? "available" : "unavailable",
      session: linux ? appControlLinuxSession(env) : null,
      input: this.inputState(),
    };
    if (!state.available) return state;
    if (platform === "win32") return { ...state, accessibility: "available" };
    if (platform === "darwin" && !this.dependencies.accessibilityTrusted()) return state;
    if (this.admitted >= APP_CONTROL_MAX_PENDING_REQUESTS) {
      return { ...state, accessibility: platform === "darwin" ? "granted" : "unavailable" };
    }
    // A Settings probe is the user's retry after the worker failed to load.
    this.startLatched = false;
    this.startFailures = 0;
    this.admitted += 1;
    let probe: AppControlResult;
    try {
      const result = await this.run({ scope: { pids: [], deniedPids: [] }, command: { command: "windows" } }, signal);
      probe = result.ok ? (result.value.kind === "windows" ? result as AppControlResult : appControlFailure("native-failure")) : this.categorize(result);
    } finally {
      this.admitted -= 1;
    }
    if (platform === "darwin") {
      // Only a typed denial says anything about the helper; other failures do not revoke the grant.
      return { ...state, accessibility: !probe.ok && probe.code === "helper-permission-denied" ? "helper-denied" : "granted" };
    }
    return { ...state, accessibility: probe.ok ? "available" : "unavailable" };
  }

  async perform(
    identity: AppControlIdentity,
    command: AppControlCommand,
    signal: AbortSignal,
    runtime: AppControlRuntimeParents,
  ): Promise<AppControlResult> {
    if (!this.available) return appControlFailure("unavailable");
    if (signal.aborted) return appControlFailure("cancelled");
    if (command.command === "permissions") return { ok: true, value: this.permissions() };
    if (this.startLatched) return appControlFailure("native-failure", "start-failed");
    const { platform } = this.dependencies;
    if (!["darwin", "win32", "linux"].includes(platform)) return appControlFailure("unsupported");
    if (platform === "darwin" && !this.dependencies.accessibilityTrusted()) return appControlFailure("permission-denied");
    if (command.command === "screenshot") {
      if (!appControlScreenshotAvailable(platform, this.dependencies.env)) {
        return appControlFailure("unsupported", platform === "linux" ? "wayland" : null);
      }
      if (platform === "darwin" && !this.dependencies.screenRecordingGranted()) {
        return appControlFailure("permission-denied", "screen-recording");
      }
    }
    if (command.command === "input" && !appControlInputAvailable(platform, this.dependencies.env)) {
      return appControlFailure("unsupported", appControlInputUnavailableReason(platform, this.dependencies.env));
    }
    if (this.admitted >= APP_CONTROL_MAX_PENDING_REQUESTS) return appControlFailure("busy");
    this.admitted += 1;
    try {
      return await this.admittedPerform(identity, command, signal, runtime);
    } finally {
      this.admitted -= 1;
    }
  }

  private async admittedPerform(
    identity: AppControlIdentity,
    command: Exclude<AppControlCommand, { command: "permissions" }>,
    signal: AbortSignal,
    runtime: AppControlRuntimeParents,
  ): Promise<AppControlResult> {
    const owned = await this.ownedTree(identity, signal);
    if (!("tree" in owned)) return owned;
    // Defence in depth: the root must be a direct child of the runtime that asked (or its guardian).
    if (!runtime.parentPids.includes(owned.rootParentPid)) return appControlFailure("not-found", "launch-gone");
    const { tree } = owned;
    const deniedPids = [...new Set([...tree.deniedPids, ...this.dependencies.ownPids()])];
    const result = await this.run({ scope: { pids: tree.pids, deniedPids }, command }, signal);
    if (!result.ok) return this.categorize(result);
    if (result.value.kind === "tree") return appControlFailure("native-failure");
    if (result.value.kind !== "screenshot") return result as AppControlResult;
    const thumbnail = this.reduce(result.value.png);
    if (!thumbnail) return appControlFailure("native-failure");
    // The model-visible image is reduced from the same masked capture, and only
    // from a capture of exactly that window (macOS): a region capture can show
    // other windows over it. When it cannot be, the screenshot stays local evidence only.
    const agentImage = command.command === "screenshot" && command.agentImage && !result.value.mayIncludeOverlappingWindows
      ? this.reduceForAgent(result.value.png)
      : null;
    return {
      ok: true,
      value: { ...result.value, png: thumbnail.png, width: thumbnail.width, height: thumbnail.height, agentImage },
    };
  }

  /** Stops the worker; rejects when its exit could not be confirmed. */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const worker = this.worker;
    if (worker && !await this.stop(worker)) throw new Error("App control worker cleanup is unconfirmed.");
    if (this.unconfirmed) throw new Error("App control worker cleanup is unconfirmed.");
  }

  /** The launch's validated owned tree, reused for one second, or the failure to answer with. */
  private async ownedTree(identity: AppControlIdentity, signal: AbortSignal): Promise<CachedTree | AppControlFailure> {
    const key = `${identity.launchId}:${identity.pid}:${identity.processStartedAt}`;
    const now = this.dependencies.now?.() ?? Date.now();
    const cached = this.trees.get(key);
    if (cached && cached.expiresAt > now) return cached;
    this.trees.delete(key);
    const { platform } = this.dependencies;
    let entries: AppControlProcessEntry[];
    try {
      // Windows (Toolhelp32) and macOS (libproc) read the tree through native calls, so in the worker.
      entries = platform === "win32" || platform === "darwin"
        ? await this.processTableFromWorker(identity.pid, signal)
        : await this.dependencies.processTable(identity.pid);
    } catch (error) {
      if (error instanceof TreeFailure) return error.result;
      return error instanceof AppControlTreeTooLargeError
        ? appControlFailure("unavailable", "tree-too-large")
        : appControlFailure("native-failure");
    }
    const tree = appControlOwnedTree(entries, identity.pid, identity.processStartedAt);
    if (tree === "too-large") return appControlFailure("unavailable", "tree-too-large");
    if (!tree) return appControlFailure("not-found", "launch-gone");
    const entry: CachedTree = {
      tree,
      rootParentPid: entries.find(({ pid }) => pid === identity.pid)!.parentPid,
      expiresAt: now + TREE_CACHE_MS,
    };
    for (const [candidate, value] of this.trees) if (value.expiresAt <= now) this.trees.delete(candidate);
    if (this.trees.size >= MAX_CACHED_TREES) this.trees.delete(this.trees.keys().next().value!);
    this.trees.set(key, entry);
    return entry;
  }

  private categorize(result: AppControlFailure): AppControlFailure {
    // Only a typed native denial while macOS lists Inertia as allowed is the helper's own.
    if (result.code === "permission-denied" && this.dependencies.platform === "darwin"
      && result.reason === null && this.dependencies.accessibilityTrusted()) {
      return appControlFailure("helper-permission-denied", null, result.dispatched);
    }
    return result;
  }

  private reduce(png: Uint8Array): AppControlThumbnail | null {
    try {
      const thumbnail = this.dependencies.reduceThumbnail(png);
      return thumbnail && thumbnail.png.byteLength <= APP_CONTROL_MAX_PNG_BYTES
        && thumbnail.width <= THUMBNAIL_WIDTH && thumbnail.height <= THUMBNAIL_HEIGHT ? thumbnail : null;
    } catch {
      return null;
    }
  }

  private reduceForAgent(png: Uint8Array): AppControlThumbnail | null {
    try {
      const image = this.dependencies.reduceAgentImage(png);
      return image && image.png.byteLength <= APP_CONTROL_MAX_AGENT_PNG_BYTES
        && Math.max(image.width, image.height) <= APP_CONTROL_MAX_AGENT_IMAGE_EDGE
        && image.width * image.height <= APP_CONTROL_MAX_AGENT_IMAGE_PIXELS
        && image.width > 0 && image.height > 0 ? image : null;
    } catch {
      return null;
    }
  }

  private async processTableFromWorker(rootPid: number, signal: AbortSignal): Promise<AppControlProcessEntry[]> {
    const result = await this.run({ scope: { pids: [], deniedPids: [] }, command: { command: "tree", rootPid } }, signal);
    if (!result.ok) throw new TreeFailure(this.categorize(result));
    if (result.value.kind !== "tree") throw new TreeFailure(appControlFailure("native-failure"));
    return result.value.entries;
  }

  /**
   * Runs one worker command after the ones queued before it. A cancelled call
   * is answered at once; a native call already running cannot be interrupted,
   * so the next command still waits until the worker answers or is recycled.
   */
  private run(
    request: Omit<AppControlWorkerRequest, "id">,
    signal: AbortSignal,
  ): Promise<AppControlWorkerResult> {
    this.queued += 1;
    let settled = false;
    let answer!: (result: AppControlWorkerResult) => void;
    const answered = new Promise<AppControlWorkerResult>((resolve) => { answer = resolve; });
    const reply = (result: AppControlWorkerResult): void => {
      if (settled) return;
      settled = true;
      answer(result);
    };
    const onQueuedAbort = (): void => reply(appControlFailure("cancelled"));
    signal.addEventListener("abort", onQueuedAbort, { once: true });
    const step = this.chain.then(async () => {
      signal.removeEventListener("abort", onQueuedAbort);
      if (!settled) await this.execute(request, signal, reply);
    });
    this.chain = step
      .catch(() => reply(appControlFailure("native-failure")))
      .finally(() => { this.queued -= 1; });
    return answered;
  }

  private async execute(
    request: Omit<AppControlWorkerRequest, "id">,
    signal: AbortSignal,
    reply: (result: AppControlWorkerResult) => void,
  ): Promise<void> {
    if (!this.available) return reply(appControlFailure("unavailable"));
    if (this.startLatched) return reply(appControlFailure("native-failure", "start-failed"));
    if (signal.aborted) return reply(appControlFailure("cancelled"));
    this.clearIdle();
    const worker = this.ensureWorker();
    const ready = await worker.ready;
    if (!ready || worker.exited) {
      await this.recycle(worker);
      if (!ready) this.startFailures += 1;
      if (this.startFailures >= START_FAILURE_LIMIT) this.startLatched = true;
      return reply(appControlFailure("native-failure", this.startLatched ? "start-failed" : null));
    }
    this.startFailures = 0;
    const id = this.nextId++;
    const mayDispatch = mayReachApp(request.command);
    const full: AppControlWorkerRequest = {
      ...request,
      id,
      ...(worker.captureFolder && request.command.command === "screenshot" ? { captureDirectory: worker.captureFolder.path } : {}),
    };
    const response = new Promise<unknown>((resolve) => { worker.waiting.set(id, resolve); });
    let timer: NodeJS.Timeout | undefined;
    const watchdog = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), watchdogFor(request.command));
      timer.unref?.();
    });
    const onAbort = (): void => reply(appControlFailure("cancelled", null, mayDispatch));
    signal.addEventListener("abort", onAbort, { once: true });
    let onExit!: () => void;
    const exited = new Promise<"exited">((resolve) => { onExit = () => resolve("exited"); });
    if (worker.exited) onExit();
    else worker.exitWaiters.add(onExit);
    try {
      try {
        worker.child.postMessage(full);
      } catch {
        await this.recycle(worker);
        return reply(appControlFailure("native-failure"));
      }
      const first = await Promise.race([response, watchdog, exited]);
      if (first === "timeout" || first === "exited") {
        await this.recycle(worker);
        return reply(appControlFailure(first === "timeout" ? "timeout" : "native-failure", null, mayDispatch));
      }
      const parsed = parseAppControlWorkerResponse(first, id, request.command.command);
      if (!parsed) {
        await this.recycle(worker);
        return reply(appControlFailure("native-failure", null, mayDispatch));
      }
      // A native failure may leave the binding in an unknown state: start fresh.
      if (!parsed.ok && parsed.code === "native-failure") await this.recycle(worker);
      else this.scheduleIdle();
      return reply(parsed);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      worker.exitWaiters.delete(onExit);
      worker.waiting.delete(id);
    }
  }

  private ensureWorker(): WorkerSlot {
    if (this.worker && !this.worker.exited) return this.worker;
    const child = this.dependencies.fork();
    let markExited!: () => void;
    const exit = new Promise<void>((resolve) => { markExited = resolve; });
    let markReady!: (ready: boolean) => void;
    const ready = new Promise<boolean>((resolve) => { markReady = resolve; });
    const readyTimer = setTimeout(() => markReady(false), this.dependencies.readyTimeoutMs ?? READY_TIMEOUT_MS);
    readyTimer.unref?.();
    let captureFolder: WorkerSlot["captureFolder"] = null;
    try { captureFolder = this.dependencies.captureFolder?.() ?? null; } catch { captureFolder = null; }
    const slot: WorkerSlot = { child, ready, exited: false, exit, exitWaiters: new Set(), waiting: new Map(), captureFolder };
    child.on("message", (value: unknown) => {
      if (value === "ready") {
        clearTimeout(readyTimer);
        markReady(true);
        return;
      }
      const id = typeof value === "object" && value !== null ? (value as { id?: unknown }).id : undefined;
      if (typeof id === "number") slot.waiting.get(id)?.(value);
    });
    child.once("exit", () => {
      slot.exited = true;
      clearTimeout(readyTimer);
      markReady(false);
      captureFolder?.release();
      if (this.worker === slot) this.worker = null;
      for (const waiter of slot.exitWaiters) waiter();
      slot.exitWaiters.clear();
      markExited();
    });
    this.worker = slot;
    return slot;
  }

  private async recycle(worker: WorkerSlot): Promise<void> {
    if (this.worker === worker) this.worker = null;
    await this.stop(worker);
  }

  /**
   * Kills the worker and waits for its exit; after the three-second grace it
   * is killed by force. False when even that exit was not confirmed in time.
   */
  private async stop(worker: WorkerSlot): Promise<boolean> {
    if (worker.exited) return true;
    try { worker.child.kill(); } catch { /* Exit is still awaited below. */ }
    if (await this.exitWithin(worker, APP_CONTROL_KILL_CONFIRM_MS)) return true;
    const pid = worker.child.pid;
    if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) {
      try { (this.dependencies.forceKill ?? sigkill)(pid); } catch { /* Exit is still awaited below. */ }
    }
    if (await this.exitWithin(worker, FORCE_KILL_CONFIRM_MS)) return true;
    this.unconfirmed = true;
    return false;
  }

  private async exitWithin(worker: WorkerSlot, ms: number): Promise<boolean> {
    if (worker.exited) return true;
    let timer: NodeJS.Timeout | undefined;
    const confirmed = await Promise.race([
      worker.exit.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    return confirmed;
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const worker = this.worker;
      if (worker && this.queued === 0) void this.recycle(worker);
    }, this.dependencies.idleMs ?? IDLE_MS);
    this.idleTimer.unref?.();
  }
}

/** The first reduction: within both edges and the pixel count, never enlarging; floors keep it inside. */
export function appControlReductionScale(
  size: { width: number; height: number },
  maxWidth: number,
  maxHeight: number,
  maxPixels = Number.POSITIVE_INFINITY,
): number {
  return Math.min(1, maxWidth / size.width, maxHeight / size.height, Math.sqrt(maxPixels / (size.width * size.height)));
}

class TreeFailure extends Error {
  constructor(readonly result: AppControlFailure) {
    super("tree");
  }
}

/** Reduces a masked capture within a size, pixel and byte bound with Electron's image codec. */
function reduceAppControlImage(
  png: Uint8Array,
  maxWidth: number,
  maxHeight: number,
  maxBytes: number,
  maxPixels = Number.POSITIVE_INFINITY,
): AppControlThumbnail | null {
  const image = nativeImage.createFromBuffer(Buffer.from(png));
  if (image.isEmpty()) return null;
  const size = image.getSize();
  if (size.width <= 0 || size.height <= 0) return null;
  let scale = appControlReductionScale(size, maxWidth, maxHeight, maxPixels);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const width = Math.max(1, Math.floor(size.width * scale));
    const height = Math.max(1, Math.floor(size.height * scale));
    const output = image.resize({ width, height, quality: "good" }).toPNG();
    if (output.byteLength <= maxBytes) return { png: new Uint8Array(output), width, height };
    scale *= 0.72;
  }
  return null;
}

/** The Evidence thumbnail: at most 512 by 320 pixels and 256 KiB. */
export function reduceAppControlThumbnail(png: Uint8Array): AppControlThumbnail | null {
  return reduceAppControlImage(png, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, APP_CONTROL_MAX_PNG_BYTES);
}

/** The model-visible screenshot: long edge at most 1,536 pixels, at most 720,000 pixels and 3.75 MB. */
export function reduceAppControlAgentImage(png: Uint8Array): AppControlThumbnail | null {
  return reduceAppControlImage(
    png,
    APP_CONTROL_MAX_AGENT_IMAGE_EDGE,
    APP_CONTROL_MAX_AGENT_IMAGE_EDGE,
    APP_CONTROL_MAX_AGENT_PNG_BYTES,
    APP_CONTROL_MAX_AGENT_IMAGE_PIXELS,
  );
}

function captureRoot(): string {
  return join(realpathSync(app.getPath("userData")), "app-control-capture");
}

/** The production service: the utility worker, Electron permissions and the platform process table. */
export function createAppControlService(): AppControlService {
  const platform = process.platform;
  let swept = false;
  return new AppControlService({
    platform,
    env: process.env,
    fork: () => utilityProcess.fork(fileURLToPath(new URL("./app-control-worker.js", import.meta.url)), [], {
      env: snapshotWorkerEnvironment(process.env),
      cwd: app.getPath("userData"),
      stdio: "ignore",
      serviceName: "Inertia App Control",
    }),
    accessibilityTrusted: () => platform !== "darwin" || systemPreferences.isTrustedAccessibilityClient(false),
    screenRecordingGranted: () => platform !== "darwin" || systemPreferences.getMediaAccessStatus("screen") === "granted",
    processTable: (rootPid) => readLinuxProcessTable(rootPid),
    ownPids: () => [process.pid, ...app.getAppMetrics().map(({ pid }) => pid)],
    reduceThumbnail: reduceAppControlThumbnail,
    reduceAgentImage: reduceAppControlAgentImage,
    captureFolder: platform !== "darwin" ? undefined : () => {
      const root = captureRoot();
      if (!swept) {
        // Folders a crashed worker left behind hold nothing that is still needed.
        swept = true;
        rmSync(root, { recursive: true, force: true });
      }
      mkdirSync(root, { recursive: true, mode: 0o700 });
      if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) return null;
      const path = mkdtempSync(join(root, "capture-"));
      return { path, release: () => { void rm(path, { recursive: true, force: true }).catch(() => undefined); } };
    },
  });
}
