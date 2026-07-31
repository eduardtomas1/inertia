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
  private readonly inFlight = new Map<string, Promise<ProjectIdentityState>>();
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
  }

  async refreshAll(targets: readonly ProjectIdentityTarget[]): Promise<void> {
    const queue = [...targets];
    const workers = Array.from(
      { length: Math.min(this.concurrency, queue.length) },
      async () => {
        while (!this.disposed) {
          const target = queue.shift();
          if (!target) return;
          await this.refresh(target);
        }
      },
    );
    await Promise.all(workers);
  }

  async refresh(target: ProjectIdentityTarget): Promise<ProjectIdentityState> {
    const existing = this.inFlight.get(target.id);
    if (existing) return await existing;
    const attempt = this.run(target);
    this.inFlight.set(target.id, attempt);
    try {
      return await attempt;
    } finally {
      if (this.inFlight.get(target.id) === attempt) {
        this.inFlight.delete(target.id);
      }
    }
  }

  private async run(
    target: ProjectIdentityTarget,
  ): Promise<ProjectIdentityState> {
    if (this.disposed) return this.state(target.id);
    this.active += 1;
    this.peakActive = Math.max(this.peakActive, this.active);
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
    } finally {
      this.active -= 1;
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
