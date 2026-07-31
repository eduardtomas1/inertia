import {
  inspectProjectIdentity,
  PROJECT_IDENTITY_DEADLINE_MS,
  ProjectIdentityTimeout,
  type ProjectIdentity,
} from "./project-identity";

export const PROJECT_IDENTITY_REFRESH_CONCURRENCY = 6;

export type ProjectIdentityFreshness = "fresh" | "stale" | "unavailable";

export interface ProjectIdentityState {
  freshness: ProjectIdentityFreshness;
  checkedAt: number | null;
  reason: string | null;
}

interface ProjectIdentityTarget {
  id: string;
  path: string;
}

interface PendingProjectIdentityRefresh {
  target: ProjectIdentityTarget;
  promise: Promise<ProjectIdentityState>;
  resolve(state: ProjectIdentityState): void;
  timer: ReturnType<typeof setTimeout> | null;
  started: boolean;
  settled: boolean;
}

interface ProjectIdentityRefresherOptions {
  concurrency?: number;
  deadlineMs?: number;
  inspect?(path: string): Promise<ProjectIdentity>;
  apply(projectId: string, identity: ProjectIdentity): void;
  onSettled?(projectId: string, state: ProjectIdentityState): void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  now?(): number;
}

export class ProjectIdentityRefresher {
  private readonly states = new Map<string, ProjectIdentityState>();
  private readonly pendingByProject =
    new Map<string, PendingProjectIdentityRefresh>();
  private readonly queue: PendingProjectIdentityRefresh[] = [];
  private readonly concurrency: number;
  private readonly deadlineMs: number;
  private readonly inspect: (path: string) => Promise<ProjectIdentity>;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly now: () => number;
  private active = 0;
  private peakActive = 0;
  private disposed = false;

  constructor(private readonly options: ProjectIdentityRefresherOptions) {
    this.concurrency = Math.max(
      1,
      Math.min(8, options.concurrency ?? PROJECT_IDENTITY_REFRESH_CONCURRENCY),
    );
    this.deadlineMs = Math.max(
      100,
      options.deadlineMs ?? PROJECT_IDENTITY_DEADLINE_MS,
    );
    this.inspect = options.inspect ?? inspectProjectIdentity;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.now = options.now ?? (() => Date.now());
  }

  state(projectId: string): ProjectIdentityState {
    return this.states.get(projectId) ?? {
      freshness: "stale",
      checkedAt: null,
      reason: "Project identity has not been verified yet.",
    };
  }

  peakConcurrency(): number {
    return this.peakActive;
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    for (const pending of this.pendingByProject.values()) {
      if (pending.timer) this.clearTimer(pending.timer);
      pending.timer = null;
      if (!pending.settled) {
        pending.settled = true;
        pending.resolve(this.state(pending.target.id));
      }
    }
    this.pendingByProject.clear();
  }

  async refreshAll(targets: readonly ProjectIdentityTarget[]): Promise<void> {
    await Promise.all(targets.map((target) => this.refresh(target)));
  }

  async refresh(target: ProjectIdentityTarget): Promise<ProjectIdentityState> {
    if (this.disposed) return this.state(target.id);
    const existing = this.pendingByProject.get(target.id);
    if (existing) return await existing.promise;
    let resolveAttempt = (_state: ProjectIdentityState): void => undefined;
    const attempt = new Promise<ProjectIdentityState>((resolve) => {
      resolveAttempt = resolve;
    });
    const pending: PendingProjectIdentityRefresh = {
      target,
      promise: attempt,
      resolve: resolveAttempt,
      timer: null,
      started: false,
      settled: false,
    };
    pending.timer = this.setTimer(
      () => this.timeout(pending),
      this.deadlineMs,
    );
    this.pendingByProject.set(target.id, pending);
    this.queue.push(pending);
    this.pump();
    return await attempt;
  }

  private pump(): void {
    while (
      !this.disposed
      && this.active < this.concurrency
      && this.queue.length > 0
    ) {
      const pending = this.queue.shift()!;
      if (pending.settled) {
        if (this.pendingByProject.get(pending.target.id) === pending) {
          this.pendingByProject.delete(pending.target.id);
        }
        continue;
      }
      pending.started = true;
      this.active += 1;
      this.peakActive = Math.max(this.peakActive, this.active);
      void this.inspectPending(pending).finally(() => {
        this.active -= 1;
        if (this.pendingByProject.get(pending.target.id) === pending) {
          this.pendingByProject.delete(pending.target.id);
        }
        this.pump();
      });
    }
  }

  private async inspectPending(
    pending: PendingProjectIdentityRefresh,
  ): Promise<void> {
    try {
      const identity = await this.inspect(pending.target.path);
      if (this.disposed || pending.settled) return;
      this.options.apply(pending.target.id, identity);
      this.complete(pending, {
        freshness: "fresh",
        checkedAt: this.now(),
        reason: null,
      });
    } catch (error) {
      if (this.disposed || pending.settled) return;
      this.complete(pending, {
        freshness: "unavailable",
        checkedAt: this.now(),
        reason: unavailableReason(error),
      });
    }
  }

  private timeout(pending: PendingProjectIdentityRefresh): void {
    if (this.disposed || pending.settled) return;
    this.complete(pending, {
      freshness: "unavailable",
      checkedAt: this.now(),
      reason: unavailableReason(
        new ProjectIdentityTimeout(this.deadlineMs),
      ),
    });
    if (!pending.started) {
      const queued = this.queue.indexOf(pending);
      if (queued >= 0) this.queue.splice(queued, 1);
      if (this.pendingByProject.get(pending.target.id) === pending) {
        this.pendingByProject.delete(pending.target.id);
      }
      this.pump();
    }
  }

  private complete(
    pending: PendingProjectIdentityRefresh,
    state: ProjectIdentityState,
  ): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timer) this.clearTimer(pending.timer);
    pending.timer = null;
    pending.resolve(this.settle(pending.target.id, state));
  }

  private settle(
    projectId: string,
    state: ProjectIdentityState,
  ): ProjectIdentityState {
    this.states.set(projectId, state);
    this.options.onSettled?.(projectId, state);
    return state;
  }
}

function unavailableReason(error: unknown): string {
  if (error instanceof Error && error.name === "ProjectIdentityTimeout") {
    return "The project folder did not respond in time.";
  }
  return "The project folder could not be inspected.";
}

export function projectIdentityIsUsable(
  state: ProjectIdentityState,
): boolean {
  return state.freshness === "fresh";
}
