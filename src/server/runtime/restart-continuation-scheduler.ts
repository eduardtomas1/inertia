import type { RuntimeStore } from "../database";
import { queuedRouteIdentity } from "../persistence/queued-message-repository";
import type { RestartContinuationPlan, RestartContinuationPlanInput } from "../persistence/restart-continuation-repository";
import { publicRuntimeError, RuntimeRequestError } from "../runtime-errors";
import { UPDATE_HOLD_MESSAGE } from "./update-hold";

const POLL_MS = 5_000;
const RETRY_BASE_MS = 5_000;
const MAX_ATTEMPTS = 3;
const CONTINUABLE_STATUSES: ReadonlySet<string> = new Set(["starting", "running"]);
const UNCONFIRMED = "The continuation could not be confirmed.";

type Readiness = { kind: "ready" } | { kind: "wait" } | { kind: "stale"; reason: string };

export interface RestartContinuationDependencies {
  store: RuntimeStore;
  signal: AbortSignal;
  enabled: boolean;
  held(): boolean;
  busy(conversationId: string): boolean;
  pendingInteraction(conversationId: string): boolean;
  dispatch(plan: RestartContinuationPlan, guard: () => void): Promise<void>;
  track<T>(operation: () => Promise<T>): Promise<T>;
}

export class RestartContinuationScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly retryAt = new Map<string, number>();

  constructor(private readonly dependencies: RestartContinuationDependencies) {}

  private get store(): RuntimeStore {
    return this.dependencies.store;
  }

  createPlans(conversationIds: readonly string[]): string[] {
    if (!this.dependencies.enabled) return [];
    const inputs: RestartContinuationPlanInput[] = [];
    for (const conversationId of new Set(conversationIds)) {
      const input = this.planInput(conversationId);
      if (input) inputs.push(input);
    }
    return this.store.restartContinuations.createForConversations(inputs).map(({ conversationId }) => conversationId);
  }

  start(): void {
    this.store.restartContinuations.reconcile();
    this.dependencies.signal.addEventListener("abort", () => this.clearTimer(), { once: true });
    this.schedule(POLL_MS);
  }

  arm(): void {
    this.schedule(0);
  }

  async tick(): Promise<void> {
    if (this.running || this.dependencies.signal.aborted || !this.dependencies.enabled) return;
    this.running = true;
    try {
      if (!this.dependencies.held()) await this.dependencies.track(async () => await this.dispatchWaiting());
    } catch {
      return;
    } finally {
      this.running = false;
      if (this.hasWaitingPlans()) this.schedule(POLL_MS);
    }
  }

  assertDispatch(plan: RestartContinuationPlan): void {
    this.dependencies.signal.throwIfAborted();
    if (this.dependencies.held()) throw new RuntimeRequestError(UPDATE_HOLD_MESSAGE);
    const saved = this.store.restartContinuations.forConversation(plan.conversationId);
    if (saved?.id !== plan.id || saved.state !== "dispatching" || this.readiness(plan).kind !== "ready") {
      throw new RuntimeRequestError("This continuation was cancelled or its chat changed.");
    }
  }

  private planInput(conversationId: string): RestartContinuationPlanInput | null {
    try {
      const conversation = this.store.conversation(conversationId);
      const turn = this.store.latestAgentTurnForConversation(conversationId);
      if (!turn || conversation.archivedAt !== null || !CONTINUABLE_STATUSES.has(turn.status)) return null;
      const watcher = this.store.watcherLinks.policyForConversation(conversationId);
      if (watcher && watcher.status !== "detached") return null;
      if (this.dependencies.pendingInteraction(conversationId) || this.store.queuedMessages.list(conversationId).length > 0) return null;
      return { conversationId, interruptedTurnId: turn.id, routeIdentity: queuedRouteIdentity(conversation) };
    } catch {
      return null;
    }
  }

  private readiness(plan: RestartContinuationPlan): Readiness {
    let conversation: ReturnType<RuntimeStore["conversation"]>;
    try {
      conversation = this.store.conversation(plan.conversationId);
    } catch {
      return { kind: "stale", reason: "The chat no longer exists." };
    }
    if (conversation.archivedAt !== null) return { kind: "stale", reason: "The chat was archived." };
    const turn = this.store.latestAgentTurnForConversation(plan.conversationId);
    if (turn?.id !== plan.interruptedTurnId) return { kind: "stale", reason: "The chat moved on before it could continue." };
    if (CONTINUABLE_STATUSES.has(turn.status)) return { kind: "wait" };
    if (turn.status !== "interrupted" || turn.terminalReason !== "app-update") {
      return { kind: "stale", reason: "The interrupted turn ended another way." };
    }
    if (queuedRouteIdentity(conversation) !== plan.routeIdentity) return { kind: "stale", reason: "The chat's model or workspace changed." };
    if (this.store.queuedMessages.list(plan.conversationId).length > 0) return { kind: "stale", reason: "The chat has a queued message." };
    if (this.dependencies.pendingInteraction(plan.conversationId)) return { kind: "stale", reason: "The chat is waiting for an answer." };
    return { kind: "ready" };
  }

  private async dispatchWaiting(): Promise<void> {
    const waiting = this.store.restartContinuations.listWaiting();
    const ids = new Set(waiting.map(({ id }) => id));
    for (const id of this.retryAt.keys()) if (!ids.has(id)) this.retryAt.delete(id);
    for (const plan of waiting) {
      if (this.dependencies.signal.aborted || this.dependencies.held()) return;
      if ((this.retryAt.get(plan.id) ?? 0) > Date.now()) continue;
      await this.advance(plan);
    }
  }

  private async advance(plan: RestartContinuationPlan): Promise<void> {
    const readiness = this.readiness(plan);
    if (readiness.kind === "stale") {
      this.store.restartContinuations.cancel(plan, readiness.reason);
      return;
    }
    if (readiness.kind === "wait" || this.dependencies.busy(plan.conversationId)) return;
    if (!this.store.restartContinuations.claim(plan)) return;
    const claimed: RestartContinuationPlan = { ...plan, state: "dispatching", attempts: plan.attempts + 1 };
    try {
      await this.dependencies.dispatch(claimed, () => this.assertDispatch(claimed));
      const saved = this.store.restartContinuations.forConversation(plan.conversationId);
      if (saved?.id === plan.id && saved.state === "dispatching") throw new RuntimeRequestError(UNCONFIRMED);
      this.retryAt.delete(plan.id);
    } catch (error) {
      this.failed(claimed, error);
    }
  }

  private failed(plan: RestartContinuationPlan, error: unknown): void {
    const readiness = this.readiness(plan);
    if (readiness.kind === "stale") {
      this.store.restartContinuations.cancel(plan, readiness.reason);
      return;
    }
    if (this.dependencies.signal.aborted || this.dependencies.held()) {
      this.store.restartContinuations.release(plan, null);
      return;
    }
    const message = publicRuntimeError(error);
    if (plan.attempts >= MAX_ATTEMPTS) {
      this.store.restartContinuations.block(plan, message);
      return;
    }
    this.store.restartContinuations.release(plan, message);
    this.retryAt.set(plan.id, Date.now() + RETRY_BASE_MS * 3 ** (plan.attempts - 1));
  }

  private hasWaitingPlans(): boolean {
    try {
      return this.store.restartContinuations.listWaiting().length > 0;
    } catch {
      return false;
    }
  }

  private schedule(delay: number): void {
    this.clearTimer();
    if (this.dependencies.signal.aborted || !this.dependencies.enabled) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
