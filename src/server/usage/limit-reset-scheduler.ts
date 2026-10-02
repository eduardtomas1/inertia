import type { Conversation } from "../../shared/contracts";
import type { LimitResetResult } from "../../shared/limit-reset";
import type { NativeUsageAccount } from "./subscription-io";
import type { RuntimeStore } from "../database";
import { RuntimeRequestError, publicRuntimeError } from "../runtime-errors";
import { publicLimitResetPlan, type StoredLimitResetPlan } from "../persistence/limit-reset-repository";
import { queuedRouteIdentity } from "../persistence/queued-message-repository";
import { matchesFailedNativeTurn, resetQuota, resumeAccountIdentity, sameReportedReset } from "./limit-reset-policy";

export interface LimitResetDependencies {
  store: RuntimeStore;
  signal: AbortSignal;
  enabled: boolean;
  readAccount(providerId: Conversation["providerId"], force: boolean, model?: string, cwd?: string, interactive?: boolean): Promise<NativeUsageAccount | null>;
  busy(conversationId: string): boolean;
  dispatch(plan: StoredLimitResetPlan, guard: () => void): Promise<void>;
  track<T>(operation: () => Promise<T>): Promise<T>;
  changed(conversationId: string): void;
}
export class LimitResetScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  constructor(private readonly dependencies: LimitResetDependencies) {}
  private current(plan: StoredLimitResetPlan): boolean {
    const { store } = this.dependencies;
    try {
      const conversation = store.conversation(plan.conversationId);
      const turn = store.latestAgentTurnForConversation(plan.conversationId);
      return matchesFailedNativeTurn(conversation, turn) && turn?.id === plan.failedTurnId
        && queuedRouteIdentity(conversation) === plan.routeIdentity;
    } catch { return false; }
  }
  assertDispatch(plan: StoredLimitResetPlan): void {
    this.dependencies.signal.throwIfAborted();
    const saved = this.dependencies.store.limitResets.get(plan.conversationId);
    if (!saved || saved.id !== plan.id || saved.state !== "dispatching" || !this.current(plan)) throw new RuntimeRequestError("This reset plan was cancelled or its chat changed.");
  }
  private async offer(conversationId: string, force: boolean, interactive: boolean) {
    const { store } = this.dependencies;
    const conversation = store.conversation(conversationId);
    const turn = store.latestAgentTurnForConversation(conversationId);
    if (!matchesFailedNativeTurn(conversation, turn) || !turn || this.dependencies.busy(conversationId)) return null;
    const route = queuedRouteIdentity(conversation);
    const account = await this.dependencies.readAccount(conversation.providerId, force, turn.model, store.conversationPath(conversationId), interactive);
    this.dependencies.signal.throwIfAborted();
    if (account?.keychain === "deferred") return "check" as const;
    const current = store.conversation(conversationId);
    if (!account || account.providerId !== conversation.providerId || route !== queuedRouteIdentity(current)
      || store.latestAgentTurnForConversation(conversationId)?.id !== turn.id
      || !matchesFailedNativeTurn(current, store.latestAgentTurnForConversation(conversationId))) return null;
    const quota = resetQuota(account, turn.model);
    return quota.kind === "exhausted" ? {
      failedTurnId: turn.id, resetsAt: quota.resetsAt,
      accountIdentity: resumeAccountIdentity(account), routeIdentity: route,
    } : null;
  }
  async get(conversationId: string, refresh = false): Promise<LimitResetResult> {
    const { store } = this.dependencies;
    store.conversation(conversationId);
    let plan = store.limitResets.get(conversationId);
    if (plan && ["waiting", "dispatching"].includes(plan.state) && !this.current(plan)) {
      store.limitResets.settle(plan, "blocked", "The chat changed. Choose a new reset action to continue.");
      this.dependencies.changed(conversationId);
      plan = store.limitResets.get(conversationId);
    }
    if (plan && ["waiting", "dispatching"].includes(plan.state)) {
      return { kind: "conversation.limit-reset", conversationId, plan: publicLimitResetPlan(plan), needsCheck: false,
        offer: { failedTurnId: plan.failedTurnId, resetsAt: plan.resetsAt, canResume: this.dependencies.enabled } };
    }
    const offer = await this.offer(conversationId, refresh, refresh).catch(() => null);
    plan = store.limitResets.get(conversationId);
    return { kind: "conversation.limit-reset", conversationId, needsCheck: offer === "check",
      offer: offer && offer !== "check" ? { failedTurnId: offer.failedTurnId, resetsAt: offer.resetsAt, canResume: this.dependencies.enabled && offer.accountIdentity !== null } : null,
      plan: plan ? publicLimitResetPlan(plan) : null };
  }
  async schedule(input: { conversationId: string; id: string; failedTurnId: string; resetsAt: string }): Promise<LimitResetResult> {
    if (!this.dependencies.enabled) throw new RuntimeRequestError("Automatic resume requires an available provider runtime.");
    const old = this.dependencies.store.limitResets.get(input.conversationId);
    if (old?.id === input.id) {
      if (old.failedTurnId !== input.failedTurnId || !sameReportedReset(old.resetsAt, input.resetsAt)) throw new RuntimeRequestError("This reset action identity was reused.");
      return this.get(input.conversationId);
    }
    const offer = await this.offer(input.conversationId, true, true);
    if (!offer || offer === "check" || !offer.accountIdentity || offer.failedTurnId !== input.failedTurnId || !sameReportedReset(offer.resetsAt, input.resetsAt)) throw new RuntimeRequestError("The reported limit changed. Refresh this chat before scheduling a resume.");
    const current = this.dependencies.store.limitResets.get(input.conversationId);
    if (current && ["waiting", "dispatching"].includes(current.state)) return this.get(input.conversationId);
    this.dependencies.store.limitResets.save({ ...input, ...offer, accountIdentity: offer.accountIdentity,
      nextAttemptAt: offer.resetsAt, attempts: 0, state: "waiting", error: null, turnId: null });
    this.dependencies.changed(input.conversationId);
    this.arm();
    return this.get(input.conversationId);
  }
  cancel(conversationId: string, id: string): void {
    const plan = this.dependencies.store.limitResets.get(conversationId);
    if (plan?.id === id) {
      this.dependencies.store.limitResets.settle(plan, "cancelled", null);
      this.dependencies.changed(conversationId);
    }
    this.arm();
  }
  async snooze(input: { conversationId: string; failedTurnId: string; resetsAt: string }): Promise<void> {
    const offer = await this.offer(input.conversationId, true, true);
    if (!offer || offer === "check" || offer.failedTurnId !== input.failedTurnId || !sameReportedReset(offer.resetsAt, input.resetsAt) || this.dependencies.busy(input.conversationId)) throw new RuntimeRequestError("The reported limit changed. Refresh this chat before snoozing.");
    const turn = this.dependencies.store.latestAgentTurnForConversation(input.conversationId)!;
    if (this.dependencies.store.findWorkspaceRun(turn.runId)) this.dependencies.store.acknowledgeWorkspaceRun(turn.runId);
    this.dependencies.store.updateConversation(input.conversationId, { snoozedUntil: offer.resetsAt });
    this.dependencies.changed(input.conversationId);
  }
  start(): void {
    this.dependencies.store.limitResets.reconcile();
    this.dependencies.signal.addEventListener("abort", () => { if (this.timer) clearTimeout(this.timer); this.timer = null; }, { once: true });
    this.arm();
  }
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.dependencies.signal.aborted || !this.dependencies.enabled || this.running) return;
    const first = this.dependencies.store.limitResets.pending()[0];
    if (!first) return;
    const delay = Math.min(60_000, Math.max(1_000, Date.parse(first.nextAttemptAt) - Date.now()));
    this.timer = setTimeout(() => { this.timer = null; void this.tick(); }, delay);
    this.timer.unref();
  }
  async tick(): Promise<void> {
    if (this.running || this.dependencies.signal.aborted || !this.dependencies.enabled) return;
    this.running = true;
    try {
      await this.dependencies.track(async () => {
        for (const plan of this.dependencies.store.limitResets.pending()) {
          if (this.dependencies.signal.aborted) break;
          if (!this.current(plan)) {
            this.dependencies.store.limitResets.settle(plan, "blocked", "The chat changed. Choose a new reset action to continue.");
            this.dependencies.changed(plan.conversationId);
            continue;
          }
          if (Date.parse(plan.nextAttemptAt) > Date.now()) continue;
          if (!this.dependencies.store.limitResets.claim(plan)) continue;
          try {
            this.assertDispatch(plan);
            if (this.dependencies.busy(plan.conversationId)) throw new RuntimeRequestError("This chat is busy. Resume it manually when it is ready.");
            const conversation = this.dependencies.store.conversation(plan.conversationId);
            const model = this.dependencies.store.latestAgentTurnForConversation(plan.conversationId)!.model;
            const account = await this.dependencies.readAccount(conversation.providerId, true, model, this.dependencies.store.conversationPath(plan.conversationId), false);
            this.assertDispatch(plan);
            if (!account || account.providerId !== conversation.providerId || resumeAccountIdentity(account) !== plan.accountIdentity) throw new RuntimeRequestError("The account changed or could not be checked. Resume this chat manually.");
            const quota = resetQuota(account, model);
            if (quota.kind !== "available") {
              if (plan.attempts >= 2) throw new RuntimeRequestError("The provider has not confirmed available quota. Refresh limits before resuming.");
              this.dependencies.store.limitResets.retry(plan, new Date(Date.now() + 30_000).toISOString());
              continue;
            }
            await this.dependencies.dispatch(plan, () => this.assertDispatch(plan));
          } catch (error) {
            if (this.dependencies.signal.aborted) this.dependencies.store.limitResets.retry(plan, new Date().toISOString());
            else this.dependencies.store.limitResets.settle(plan, "blocked", publicRuntimeError(error));
          } finally { this.dependencies.changed(plan.conversationId); }
        }
      });
    } catch { /* Admission may be closed during backup/import; the durable plan remains pending. */ }
    finally { this.running = false; this.arm(); }
  }
}
