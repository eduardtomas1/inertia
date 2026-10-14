import type { AppSnapshot } from "../../shared/contracts";

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
  private work: Promise<void> = Promise.resolve();

  constructor(private readonly options: PostReadyWorkOptions) {}

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
