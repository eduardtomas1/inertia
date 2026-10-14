import type { AppSnapshot } from "../../shared/contracts";

export const FIRST_CLIENT_WAIT_MS = 1_000;

export function shellSnapshotDigest(snapshot: AppSnapshot): string {
  const diagnostics = snapshot.lifecycleDiagnostics
    ? { ...snapshot.lifecycleDiagnostics, capturedAt: null, runtimeUptimeMs: null }
    : null;
  return JSON.stringify({ ...snapshot, sync: null, lifecycleDiagnostics: diagnostics });
}

export interface PostReadyWorkOptions {
  readonly isClosed: () => boolean;
  readonly isBlocked: () => boolean;
  readonly track: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly startBackups: () => void;
  readonly refreshProjectIdentities: () => Promise<void>;
  readonly afterProjectIdentityRefresh: () => Promise<void> | undefined;
  readonly reconcileWorkspaces: () => Promise<unknown>;
  readonly reconcileArtifacts: () => Promise<boolean>;
  readonly startProviderDiscovery: () => void;
  readonly snapshotDigest: () => string;
  readonly broadcastSnapshot: () => void;
}

export class PostReadyWork {
  identityRefresh: Promise<void> = Promise.resolve();
  artifactReconciliation: Promise<void> | null = null;
  artifactReconciliationActive = false;
  private started = false;
  private deferred = false;
  private work: Promise<void> = Promise.resolve();
  private connected: () => void = () => undefined;
  private readonly firstConnection = new Promise<void>((resolve) => {
    this.connected = resolve;
  });

  constructor(private readonly options: PostReadyWorkOptions) {}

  clientConnected(): void {
    setImmediate(this.connected);
  }

  startAfterFirstClient(waitMs = FIRST_CLIENT_WAIT_MS): void {
    if (this.started || this.deferred) return;
    this.deferred = true;
    const timer = setTimeout(() => void this.start(), waitMs);
    timer.unref();
    void this.firstConnection.then(() => {
      clearTimeout(timer);
      void this.start();
    });
  }

  beforeUpdatePreparation<T>(prepare: () => T): T {
    if (this.deferred) void this.start();
    return prepare();
  }

  start(): Promise<void> {
    if (this.started) return this.work;
    if (this.options.isClosed() || this.options.isBlocked()) return Promise.resolve();
    this.started = true;
    this.startBackups();
    const before = this.options.snapshotDigest();
    this.identityRefresh = this.options.track(() => this.options.refreshProjectIdentities()
      .catch(() => undefined)
      .then(() => this.broadcastIfChanged(before))
      .then(() => this.options.afterProjectIdentityRefresh()))
      .catch(() => undefined);
    this.work = this.options.track(() => this.options.reconcileWorkspaces()
      .then(() => this.broadcastIfChanged(before)))
      .catch(() => undefined);
    this.artifactReconciliationActive = true;
    this.artifactReconciliation = this.options.track(() => this.options.reconcileArtifacts()
      .then((changed) => {
        if (changed && !this.options.isClosed()) this.options.broadcastSnapshot();
      }))
      .catch(() => undefined)
      .finally(() => {
        this.artifactReconciliationActive = false;
      });
    this.options.startProviderDiscovery();
    return this.work;
  }

  private startBackups(): void {
    try {
      this.options.startBackups();
    } catch {
      return;
    }
  }

  private broadcastIfChanged(before: string): void {
    if (this.options.isClosed()) return;
    if (this.options.snapshotDigest() !== before) this.options.broadcastSnapshot();
  }
}
