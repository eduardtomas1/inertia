import type { Conversation } from "../../shared/contracts";
import type { LimitResetResult } from "../../shared/limit-reset";
import type { NativeUsageAccount } from "./subscription-io";
import type { RuntimeStore } from "../database";
import { RuntimeRequestError, publicRuntimeError } from "../runtime-errors";
import { publicLimitResetPlan, type StoredLimitResetPlan } from "../persistence/limit-reset-repository";
import { queuedRouteIdentity } from "../persistence/queued-message-repository";
import { MISSED_RESUME_AFTER_MS, matchesFailedNativeTurn, resetQuota, resumeAccountIdentity, sameReportedReset } from "./limit-reset-policy";

const LIMIT_CHANGED = "The reported limit changed. Check the new reset time and try again.";
const RUNTIME_UNAVAILABLE = "Automatic resume requires an available provider runtime.";
const ACCOUNT_UNCONFIRMED = "The provider did not report an account Inertia can confirm at the reset.";
const CHAT_CHANGED = "The chat changed. Choose a new reset action to continue.";
const STALLED = "Inertia could not update this resume. Resume this chat manually.";
const MAX_BACKOFF_MS = 5 * 60_000;
const STALLED_AFTER_FAILURES = 5;
type OfferMode = "automatic" | "explicit";
interface Offer {
  failedTurnId: string;
  resetsAt: string;
  accountIdentity: string | null;
  routeIdentity: string;
  unavailableReason: string | null;
}
export interface LimitResetDependencies {
  store: RuntimeStore;
  signal: AbortSignal;
  enabled: boolean;
  readAccount(providerId: Conversation["providerId"], force: boolean, model?: string, cwd?: string,
    interactive?: boolean): Promise<NativeUsageAccount | null>;
  cachedAccount(providerId: Conversation["providerId"], model?: string, cwd?: string): NativeUsageAccount | null;
  busy(conversationId: string): boolean;
  dispatch(plan: StoredLimitResetPlan, guard: () => void): Promise<void>;
  track<T>(operation: () => Promise<T>): Promise<T>;
  changed(conversationId: string): void;
}

export class LimitResetScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private failures = 0;
  private readonly offers = new Map<string, Promise<Offer | null>>();
  constructor(private readonly dependencies: LimitResetDependencies) {}
  private get store(): RuntimeStore {
    return this.dependencies.store;
  }
  private current(plan: StoredLimitResetPlan): boolean {
    try {
      const conversation = this.store.conversation(plan.conversationId);
      const turn = this.store.latestAgentTurnForConversation(plan.conversationId);
      return matchesFailedNativeTurn(conversation, turn)
        && turn?.id === plan.failedTurnId
        && queuedRouteIdentity(conversation) === plan.routeIdentity
        && this.providerOwned(conversation);
    } catch {
      return false;
    }
  }
  private providerOwned(conversation: Conversation): boolean {
    try {
      this.store.assertConversationProvider(conversation.id, conversation.providerId);
      return true;
    } catch {
      return false;
    }
  }
  assertDispatch(plan: StoredLimitResetPlan): void {
    this.dependencies.signal.throwIfAborted();
    const saved = this.store.limitResets.get(plan.conversationId);
    if (!saved || saved.id !== plan.id || saved.state !== "dispatching" || !this.current(plan)) {
      throw new RuntimeRequestError("This reset plan was cancelled or its chat changed.");
    }
  }
  private offer(conversationId: string, mode: OfferMode): Promise<Offer | null> {
    const key = `${conversationId}:${mode}`;
    const running = this.offers.get(key);
    if (running) return running;
    const next = this.readOffer(conversationId, mode).finally(() => {
      if (this.offers.get(key) === next) this.offers.delete(key);
    });
    this.offers.set(key, next);
    return next;
  }
  private async readOffer(conversationId: string, mode: OfferMode): Promise<Offer | null> {
    const conversation = this.store.conversation(conversationId);
    const turn = this.store.latestAgentTurnForConversation(conversationId);
    if (!turn || !matchesFailedNativeTurn(conversation, turn)) return null;
    if (!this.providerOwned(conversation) || this.dependencies.busy(conversationId)) return null;
    const route = queuedRouteIdentity(conversation);
    const cwd = this.store.conversationPath(conversationId);
    const automatic = mode === "automatic";
    const account = automatic && !this.store.limitResets.usageLimited(turn.id)
      ? this.dependencies.cachedAccount(conversation.providerId, turn.model, cwd)
      : await this.dependencies.readAccount(conversation.providerId, !automatic, turn.model, cwd, !automatic);
    this.dependencies.signal.throwIfAborted();
    const current = this.store.conversation(conversationId);
    const latest = this.store.latestAgentTurnForConversation(conversationId);
    if (!account || account.providerId !== conversation.providerId) return null;
    if (route !== queuedRouteIdentity(current) || latest?.id !== turn.id || !matchesFailedNativeTurn(current, latest)) return null;
    const quota = resetQuota(account, turn.model);
    if (quota.kind !== "exhausted") return null;
    const accountIdentity = resumeAccountIdentity(account);
    return {
      failedTurnId: turn.id,
      resetsAt: quota.resetsAt,
      accountIdentity,
      routeIdentity: route,
      unavailableReason: !this.dependencies.enabled ? RUNTIME_UNAVAILABLE
        : accountIdentity ? null : account.resumeUnavailable ?? ACCOUNT_UNCONFIRMED,
    };
  }
  private retireStalePlan(conversationId: string): StoredLimitResetPlan | null {
    let plan = this.store.limitResets.get(conversationId);
    const latestTurnId = this.store.latestAgentTurnForConversation(conversationId)?.id;
    if (plan && ["waiting", "dispatching", "blocked", "missed"].includes(plan.state) && latestTurnId !== plan.failedTurnId) {
      this.store.limitResets.settle(plan, "cancelled", null);
      this.dependencies.changed(conversationId);
      plan = this.store.limitResets.get(conversationId);
    }
    if (plan && ["waiting", "dispatching", "missed"].includes(plan.state) && !this.current(plan)) {
      this.store.limitResets.settle(plan, "blocked", CHAT_CHANGED);
      this.dependencies.changed(conversationId);
      plan = this.store.limitResets.get(conversationId);
    }
    return plan;
  }
  async get(conversationId: string, refresh = false): Promise<LimitResetResult> {
    this.store.conversation(conversationId);
    const plan = this.retireStalePlan(conversationId);
    if (plan && ["waiting", "dispatching"].includes(plan.state)) {
      return {
        kind: "conversation.limit-reset",
        conversationId,
        plan: publicLimitResetPlan(plan),
        offer: {
          failedTurnId: plan.failedTurnId,
          resetsAt: plan.resetsAt,
          canResume: this.dependencies.enabled,
          unavailableReason: this.dependencies.enabled ? null : RUNTIME_UNAVAILABLE,
        },
      };
    }
    const offer = await this.offer(conversationId, refresh ? "explicit" : "automatic").catch(() => null);
    const latestPlan = this.store.limitResets.get(conversationId);
    return {
      kind: "conversation.limit-reset",
      conversationId,
      offer: offer ? {
        failedTurnId: offer.failedTurnId,
        resetsAt: offer.resetsAt,
        canResume: offer.unavailableReason === null,
        unavailableReason: offer.unavailableReason,
      } : null,
      plan: latestPlan ? publicLimitResetPlan(latestPlan) : null,
    };
  }
  async schedule(input: { conversationId: string; id: string; failedTurnId: string; resetsAt: string }): Promise<LimitResetResult> {
    if (!this.dependencies.enabled) throw new RuntimeRequestError(RUNTIME_UNAVAILABLE);
    const old = this.store.limitResets.get(input.conversationId);
    if (old?.id === input.id) {
      if (old.failedTurnId !== input.failedTurnId || !sameReportedReset(old.resetsAt, input.resetsAt)) {
        throw new RuntimeRequestError("This reset action identity was reused.");
      }
      return this.get(input.conversationId);
    }
    if (old && ["waiting", "dispatching"].includes(old.state) && this.current(old)) return this.get(input.conversationId);
    const offer = await this.offer(input.conversationId, "explicit");
    if (!offer || !offer.accountIdentity || offer.unavailableReason !== null) throw new RuntimeRequestError(LIMIT_CHANGED);
    if (offer.failedTurnId !== input.failedTurnId || !sameReportedReset(offer.resetsAt, input.resetsAt)) {
      throw new RuntimeRequestError(LIMIT_CHANGED);
    }
    const current = this.store.limitResets.get(input.conversationId);
    if (current && ["waiting", "dispatching"].includes(current.state)) return this.get(input.conversationId);
    this.store.limitResets.save({
      id: input.id,
      conversationId: input.conversationId,
      failedTurnId: offer.failedTurnId,
      resetsAt: offer.resetsAt,
      routeIdentity: offer.routeIdentity,
      accountIdentity: offer.accountIdentity,
      nextAttemptAt: offer.resetsAt,
      attempts: 0,
      state: "waiting",
      error: null,
      turnId: null,
    });
    this.dependencies.changed(input.conversationId);
    this.failures = 0;
    this.arm();
    return this.get(input.conversationId);
  }
  async resume(input: { conversationId: string; id: string }): Promise<LimitResetResult> {
    if (!this.dependencies.enabled) throw new RuntimeRequestError(RUNTIME_UNAVAILABLE);
    const plan = this.store.limitResets.get(input.conversationId);
    const rearmed = plan?.id === input.id && plan.state === "missed" && this.current(plan)
      && this.store.limitResets.rearm(plan, new Date().toISOString());
    if (!rearmed) throw new RuntimeRequestError("This resume is no longer waiting. Check the chat before sending again.");
    this.dependencies.changed(input.conversationId);
    this.failures = 0;
    this.arm();
    return this.get(input.conversationId);
  }
  cancel(conversationId: string, id: string): void {
    const plan = this.store.limitResets.get(conversationId);
    if (plan?.id === id) {
      this.store.limitResets.settle(plan, "cancelled", null);
      this.dependencies.changed(conversationId);
    }
    this.arm();
  }
  async snooze(input: { conversationId: string; failedTurnId: string; resetsAt: string }): Promise<void> {
    const offer = await this.offer(input.conversationId, "explicit");
    if (!offer || offer.failedTurnId !== input.failedTurnId || !sameReportedReset(offer.resetsAt, input.resetsAt)) {
      throw new RuntimeRequestError(LIMIT_CHANGED);
    }
    if (this.dependencies.busy(input.conversationId)) throw new RuntimeRequestError(LIMIT_CHANGED);
    const turn = this.store.latestAgentTurnForConversation(input.conversationId)!;
    if (this.store.findWorkspaceRun(turn.runId)) this.store.acknowledgeWorkspaceRun(turn.runId);
    this.store.updateConversation(input.conversationId, { snoozedUntil: offer.resetsAt });
    this.dependencies.changed(input.conversationId);
  }
  start(): void {
    this.store.limitResets.reconcile();
    this.dependencies.signal.addEventListener("abort", () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    }, { once: true });
    this.arm();
  }
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.dependencies.signal.aborted || !this.dependencies.enabled || this.running) return;
    let delay: number;
    if (this.failures > 0) {
      delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** this.failures);
    } else {
      const first = this.store.limitResets.pending()[0];
      if (!first) return;
      delay = Math.min(60_000, Math.max(1_000, Date.parse(first.nextAttemptAt) - Date.now()));
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
    this.timer.unref();
  }
  async tick(): Promise<void> {
    if (this.running || this.dependencies.signal.aborted || !this.dependencies.enabled) return;
    this.running = true;
    try {
      await this.dependencies.track(async () => {
        for (const plan of this.store.limitResets.pending()) {
          if (this.dependencies.signal.aborted) break;
          await this.advance(plan);
        }
      });
      this.failures = 0;
    } catch {
      this.failures += 1;
      if (this.failures >= STALLED_AFTER_FAILURES) this.stall();
    } finally {
      this.running = false;
      this.arm();
    }
  }
  private stall(): void {
    for (const plan of this.dueSafely()) {
      try {
        this.store.limitResets.settle(plan, "blocked", STALLED);
        this.dependencies.changed(plan.conversationId);
      } catch {
        continue;
      }
    }
  }
  private dueSafely(): StoredLimitResetPlan[] {
    try {
      return this.store.limitResets.pending().filter((plan) => Date.parse(plan.nextAttemptAt) <= Date.now());
    } catch {
      return [];
    }
  }
  private async advance(plan: StoredLimitResetPlan): Promise<void> {
    if (!this.current(plan)) {
      this.store.limitResets.settle(plan, "blocked", CHAT_CHANGED);
      this.dependencies.changed(plan.conversationId);
      return;
    }
    if (Date.parse(plan.nextAttemptAt) > Date.now()) return;
    if (Date.now() - Date.parse(plan.nextAttemptAt) > MISSED_RESUME_AFTER_MS) {
      this.store.limitResets.settle(plan, "missed", null);
      this.dependencies.changed(plan.conversationId);
      return;
    }
    if (!this.store.limitResets.claim(plan)) return;
    try {
      await this.attempt(plan);
    } catch (error) {
      if (this.dependencies.signal.aborted) this.store.limitResets.retry(plan, new Date().toISOString());
      else this.store.limitResets.settle(plan, "blocked", publicRuntimeError(error));
    } finally {
      this.dependencies.changed(plan.conversationId);
    }
  }
  private async attempt(plan: StoredLimitResetPlan): Promise<void> {
    this.assertDispatch(plan);
    if (this.dependencies.busy(plan.conversationId)) throw new RuntimeRequestError("This chat is busy. Resume it manually when it is ready.");
    const conversation = this.store.conversation(plan.conversationId);
    const model = this.store.latestAgentTurnForConversation(plan.conversationId)!.model;
    const cwd = this.store.conversationPath(plan.conversationId);
    const account = await this.dependencies.readAccount(conversation.providerId, true, model, cwd, false);
    this.assertDispatch(plan);
    if (!account || account.providerId !== conversation.providerId || resumeAccountIdentity(account) !== plan.accountIdentity) {
      throw new RuntimeRequestError("The account changed or could not be checked. Resume this chat manually.");
    }
    if (resetQuota(account, model).kind !== "available") {
      if (plan.attempts >= 2) throw new RuntimeRequestError("The provider has not confirmed available quota. Refresh limits before resuming.");
      this.store.limitResets.retry(plan, new Date(Date.now() + 30_000).toISOString());
      return;
    }
    await this.dependencies.dispatch(plan, () => this.assertDispatch(plan));
    const settled = this.store.limitResets.get(plan.conversationId);
    if (settled?.id === plan.id && settled.state === "dispatching") {
      throw new RuntimeRequestError("The continuation could not be confirmed. Resume this chat manually.");
    }
  }
}
