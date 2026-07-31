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
  reject(reason: unknown): void;
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
      pending.resolve(this.state(pending.target.id));
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
    let rejectAttempt = (_reason: unknown): void => undefined;
    const attempt = new Promise<ProjectIdentityState>((resolve, reject) => {
      resolveAttempt = resolve;
      rejectAttempt = reject;
    });
    const pending = {
      target,
      promise: attempt,
      resolve: resolveAttempt,
      reject: rejectAttempt,
    };
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
      this.active += 1;
      this.peakActive = Math.max(this.peakActive, this.active);
      void this.run(pending.target).then(
        pending.resolve,
        pending.reject,
      ).finally(() => {
        this.active -= 1;
        if (this.pendingByProject.get(pending.target.id) === pending) {
          this.pendingByProject.delete(pending.target.id);
        }
        this.pump();
      });
    }
  }

  private async run(
    target: ProjectIdentityTarget,
  ): Promise<ProjectIdentityState> {
    if (this.disposed) return this.state(target.id);
    try {
      const identity = await this.withDeadline(target.path);
      if (this.disposed) return this.state(target.id);
      this.options.apply(target.id, identity);
      return this.settle(target.id, {
        freshness: "fresh",
        checkedAt: this.now(),
        reason: null,
      });
    } catch (error) {
      if (this.disposed) return this.state(target.id);
      return this.settle(target.id, {
        freshness: "unavailable",
        checkedAt: this.now(),
        reason: unavailableReason(error),
      });
    }
  }

  private async withDeadline(path: string): Promise<ProjectIdentity> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        this.inspect(path),
        new Promise<never>((_resolve, reject) => {
          timer = this.setTimer(
            () => reject(new ProjectIdentityTimeout(this.deadlineMs)),
            this.deadlineMs,
          );
        }),
      ]);
    } finally {
      if (timer) this.clearTimer(timer);
    }
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
