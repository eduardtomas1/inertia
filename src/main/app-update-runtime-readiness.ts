import type { RuntimeSupervisorSnapshot } from "./runtime-supervisor-types.js";

const CANDIDATE_RUNTIME_READINESS_TIMEOUT_MS = 65_000;

function readinessFailure(
  snapshot: RuntimeSupervisorSnapshot,
): Error | null {
  if (snapshot.phase === "ready") {
    return snapshot.pid && snapshot.websocketUrl
      ? null
      : new Error("The candidate runtime readiness identity is incomplete.");
  }
  if (
    snapshot.phase === "restarting"
    || snapshot.phase === "stopping"
    || snapshot.phase === "stopped"
    || snapshot.lastError
  ) return new Error(
    snapshot.lastError ?? "The candidate runtime did not become ready.",
  );
  return null;
}

/** Candidate-only observer; ordinary startup never waits on this barrier. */
export class AppUpdateRuntimeReadiness {
  private latest: RuntimeSupervisorSnapshot | null = null;
  private pending: {
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    readonly timeout: NodeJS.Timeout;
  } | null = null;

  constructor(private readonly timeoutMs =
    CANDIDATE_RUNTIME_READINESS_TIMEOUT_MS) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("The candidate runtime readiness timeout is invalid.");
    }
  }

  observe(snapshot: RuntimeSupervisorSnapshot): void {
    this.latest = snapshot;
    const pending = this.pending;
    if (!pending) return;
    if (snapshot.phase === "ready" && !readinessFailure(snapshot)) {
      this.pending = null;
      clearTimeout(pending.timeout);
      pending.resolve();
      return;
    }
    const failure = readinessFailure(snapshot);
    if (!failure) return;
    this.pending = null;
    clearTimeout(pending.timeout);
    pending.reject(failure);
  }

  wait(): Promise<void> {
    if (this.pending) {
      return Promise.reject(new Error(
        "Candidate runtime readiness already has an active waiter.",
      ));
    }
    if (this.latest?.phase === "ready" && !readinessFailure(this.latest)) {
      return Promise.resolve();
    }
    if (this.latest) {
      const failure = readinessFailure(this.latest);
      if (failure) return Promise.reject(failure);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending?.timeout !== timeout) return;
        this.pending = null;
        reject(new Error(
          "The candidate runtime readiness deadline expired.",
        ));
      }, Math.min(this.timeoutMs, CANDIDATE_RUNTIME_READINESS_TIMEOUT_MS));
      timeout.unref();
      this.pending = { resolve, reject, timeout };
    });
  }
}
