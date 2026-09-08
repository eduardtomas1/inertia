import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { app, globalShortcut, systemPreferences, utilityProcess, type UtilityProcess } from "electron";
import { SNAPSHOT_MAX_IMAGE_BYTES, snapshotPlatformAvailable, snapshotSourceSchema, type SnapshotSource, type SnapshotState } from "../shared/snapshots.js";

export function snapshotWorkerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE", "LANG"]) {
    const value = Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
    // X11 falls back to $HOME/.Xauthority when XAUTHORITY is unset.
    if (key === "HOME" && value && (!isAbsolute(value) || value.includes("\0"))) continue;
    if (value) result[key] = value;
  }
  return result;
}

export class SnapshotError extends Error {}

export interface SnapshotWorkerResult { png: Buffer; source: SnapshotSource }
const ACCELERATOR = "CommandOrControl+Alt+S";

/** One capture at a time. A response is delivered only after its worker exits. */
export class SnapshotService {
  private enabled = false;
  private shortcut: SnapshotState["shortcut"] = process.platform === "linux" ? "accelerator" : "both-shift";
  private poller: UtilityProcess | null = null;
  private captureChild: UtilityProcess | null = null;
  private captureGeneration = 0;
  private cancelCapture: (() => Promise<void>) | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private message: string | null = null;
  private busy = false;
  private disposed = false;
  private disposalStarted = false;
  private readonly exited = new WeakSet<UtilityProcess>();
  constructor(private readonly onCapture: () => Promise<void>) {}

  // Capture failures can disable the service without ending its reporting lifetime.
  isDisposing(): boolean { return this.disposalStarted; }

  state(): SnapshotState {
    const available = snapshotPlatformAvailable(process.platform, process.env);
    const permission = process.platform !== "darwin" || (systemPreferences.isTrustedAccessibilityClient(false) && systemPreferences.getMediaAccessStatus("screen") === "granted") ? "granted" : "required";
    return { enabled: this.enabled, shortcut: this.shortcut, available, permission,
      message: !available ? "Snapshots requires macOS, Windows, or a Linux X11 desktop with accessibility support." : this.message };
  }

  // Revoke synchronously, including when IPC configuration is waiting behind a prior request.
  revokeCapture(): Promise<void> {
    this.enabled = false;
    this.captureGeneration += 1;
    return this.cancelCapture?.() ?? Promise.resolve();
  }

  async configure(enabled: boolean, shortcut: SnapshotState["shortcut"]): Promise<SnapshotState> {
    this.enabled = false;
    const captureStopped = enabled ? Promise.resolve() : this.revokeCapture();
    const generation = this.captureGeneration;
    const stopped = await Promise.allSettled([this.stopShortcut(), captureStopped]);
    if (stopped.some((result) => result.status === "rejected")) throw new SnapshotError("Snapshot worker cleanup is unconfirmed.");
    this.shortcut = process.platform === "linux" ? "accelerator" : shortcut;
    this.message = null;
    if (!enabled || this.disposed || generation !== this.captureGeneration) return this.state();
    const state = this.state();
    if (!state.available) return state;
    if (state.permission !== "granted") {
      this.message = "Allow Inertia in Accessibility and Screen Recording, then enable Snapshots again.";
      return this.state();
    }
    const trigger = (): void => { if (this.enabled && !this.busy) void this.onCapture().catch(() => undefined); };
    if (this.shortcut === "accelerator") {
      this.enabled = globalShortcut.register(ACCELERATOR, trigger);
      if (!this.enabled) this.message = "The snapshot shortcut is already used by another app.";
      return this.state();
    }
    const child = this.spawn("snapshot-shortcut-worker");
    this.poller = child;
    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(false); }, 3000);
      child.once("exit", () => { clearTimeout(timer); resolve(false); });
      child.on("message", (value: unknown) => {
        if (value === "ready") { clearTimeout(timer); resolve(true); }
        else if (value === "trigger" && this.poller === child) trigger();
      });
    });
    if (ready && this.poller === child && !this.disposed && generation === this.captureGeneration && !this.exited.has(child)) {
      this.enabled = true;
      this.heartbeat = setInterval(() => {
        try { child.postMessage("alive"); } catch { child.kill(); }
      }, 1000);
      child.once("exit", () => {
        if (this.poller !== child) return;
        this.poller = null; this.enabled = false;
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = null;
        this.message = "The snapshot shortcut stopped. Enable Snapshots again.";
      });
    } else {
      await this.stopShortcut();
      this.message = "The snapshot shortcut could not start.";
    }
    return this.state();
  }

  async capture(signal?: AbortSignal): Promise<SnapshotWorkerResult> {
    if (!this.enabled || this.busy || this.disposed || signal?.aborted) throw new SnapshotError("Snapshots is unavailable or already capturing.");
    this.busy = true;
    const generation = this.captureGeneration;
    try {
      const captured = await new Promise<SnapshotWorkerResult>((resolve, reject) => {
        const child = this.spawn("snapshot-capture-worker");
        this.captureChild = child;
        let result: SnapshotWorkerResult | null = null;
        let error: Error | null = null;
        let killTimer: NodeJS.Timeout | null = null;
        let confirmExit!: () => void;
        let failExit!: (error: Error) => void;
        const exited = new Promise<void>((resolve, reject) => { confirmExit = resolve; failExit = reject; });
        // The capture owns failures even when no disable caller requests the exit receipt.
        void exited.catch(() => undefined);
        const stop = (reason: string): void => {
          error ??= new SnapshotError(reason);
          if (killTimer) return;
          killTimer = setTimeout(() => {
            this.disposed = true;
            this.enabled = false;
            const failure = new SnapshotError("Snapshot worker cleanup is unconfirmed. Restart Inertia before capturing again.");
            failExit(failure); reject(failure);
          }, 3000);
          child.kill();
        };
        const abort = (): void => stop("Snapshot cancelled.");
        this.cancelCapture = () => { abort(); return exited; };
        const timer = setTimeout(() => stop("Snapshot capture timed out."), 10_000);
        signal?.addEventListener("abort", abort, { once: true });
        child.on("message", (value: unknown) => {
          if (result || error || !value || typeof value !== "object") return;
          const data = value as Record<string, unknown>;
          const parsed = snapshotSourceSchema.safeParse(data.source);
          if (data.ok === true && parsed.success && data.png instanceof Uint8Array && data.png.length > 8 && data.png.length <= SNAPSHOT_MAX_IMAGE_BYTES) {
            result = { source: parsed.data, png: Buffer.from(data.png) };
          } else {
            error = new SnapshotError(data.code === "incomplete" ? "This window has too much accessibility content to capture safely." : data.code === "changed" ? "The foreground window changed. Try the snapshot again." : data.code === "large" ? "This snapshot exceeds the attachment limit." : "The window could not be captured. Check screen and accessibility permissions and try again.");
          }
          try { child.postMessage("received"); } catch { stop("Snapshot capture stopped before completing."); }
        });
        child.once("exit", (code) => {
          clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
          signal?.removeEventListener("abort", abort);
          if (this.captureChild === child) { this.captureChild = null; this.cancelCapture = null; }
          confirmExit();
          if (code === 0 && result && !error) resolve(result);
          else reject(error ?? new SnapshotError("Snapshot capture stopped before completing."));
        });
        child.once("spawn", () => {
          if (error) { child.kill(); return; }
          try { child.postMessage("capture"); } catch { stop("Snapshot capture could not start."); }
        });
      });
      if (generation !== this.captureGeneration) throw new SnapshotError("Snapshot cancelled.");
      return captured;
    } finally { this.busy = false; }
  }

  private spawn(name: string): UtilityProcess {
    const child = utilityProcess.fork(fileURLToPath(new URL(`./${name}.js`, import.meta.url)), [], {
      env: snapshotWorkerEnvironment(process.env), cwd: app.getPath("userData"), stdio: "ignore", serviceName: "Inertia Snapshots",
    });
    child.once("exit", () => this.exited.add(child));
    return child;
  }

  async verifyBindings(): Promise<void> {
    if (this.busy || this.disposed) throw new SnapshotError("Snapshot binding verification is unavailable.");
    this.busy = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const child = this.spawn("snapshot-binding-worker");
        this.captureChild = child;
        let ready = false;
        let timedOut = false;
        let cleanupTimer: NodeJS.Timeout | null = null;
        const timer = setTimeout(() => {
          timedOut = true;
          cleanupTimer = setTimeout(() => {
            this.disposed = true;
            reject(new SnapshotError("Snapshot binding worker cleanup is unconfirmed."));
          }, 3000);
          child.kill();
        }, 10_000);
        child.on("message", (value: unknown) => {
          if (value === "bindings-ready") {
            ready = true;
            try { child.postMessage("received"); } catch { ready = false; child.kill(); }
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timer); if (cleanupTimer) clearTimeout(cleanupTimer);
          if (this.captureChild === child) this.captureChild = null;
          if (ready && code === 0 && !timedOut) resolve();
          else reject(new SnapshotError("Packaged snapshot native bindings could not load."));
        });
      });
    } finally { this.busy = false; }
  }

  private async stopShortcut(): Promise<void> {
    globalShortcut.unregister(ACCELERATOR);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const child = this.poller;
    if (child) {
      await this.stopWorker(child);
      if (this.poller === child) this.poller = null;
    }
  }

  private stopWorker(child: UtilityProcess): Promise<void> {
    if (this.exited.has(child)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new SnapshotError("Snapshot worker cleanup is unconfirmed.")), 3000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill();
    });
  }

  async dispose(): Promise<void> {
    this.disposalStarted = true;
    this.disposed = true; this.enabled = false;
    const results = await Promise.allSettled([
      this.stopShortcut(),
      ...(this.captureChild ? [this.stopWorker(this.captureChild)] : []),
    ]);
    if (results.some((result) => result.status === "rejected")) throw new SnapshotError("Snapshot worker cleanup is unconfirmed.");
  }
}
