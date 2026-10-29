import {
  SECRET_REQUEST_MAX_ACTIVE,
  agentSecretReference,
  isAgentSecretValue,
  secretRequestWaitMs,
  type SecretRequestStorage,
  type SecretRequestStatus,
} from "../../../shared/agent-secrets";
import type { AgentTurn, ChatMessage, Conversation, RuntimeMutationEvent } from "../../../shared/contracts";
import type { SecretRequestListEntry } from "../../../shared/contracts/client-command/secret-requests";
import type { ProviderId } from "../../../shared/provider";
import type { RuntimeAgentSecretRejectionReason } from "../../../node/runtime-agent-secret-protocol";
import type { RuntimeStore } from "../../database";
import {
  AgentSecretRequestError,
  type AgentSecretRequestChange,
  type AgentSecretRequestRecord,
} from "../../persistence/agent-secret-request-repository";
import type { ProviderHostToolCall, ProviderHostToolResult } from "../../provider/contracts";
import {
  agentSecretFilePath,
  agentSecretRoot,
  clearAgentSecretRoot,
  ensureAgentSecretRoot,
  newAgentSecretFileToken,
  removeAgentSecretDirectory,
  writeAgentSecretFile,
} from "./secret-files";
import { SecretOutputRedactor } from "./secret-output-redactor";
import {
  parseSecretRequestArguments,
  secretRequestDeclinedResult,
  secretRequestEndedResult,
  secretRequestFailure,
  secretRequestLimitFailure,
  secretRequestSavedResult,
  type SecretRequestEndReason,
} from "./secret-request-host-tool";

const HOUR_MS = 60 * 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = HOUR_MS;
const MAX_TIMER_MS = 2_147_483_647;

export interface AgentSecretTurnWaits {
  secretWait(conversationId: string, turnId: string, requestId: string, title: string | null): boolean;
}

export interface AgentSecretVault {
  resolve(secretReference: string): Promise<string | null>;
  forget(secretReference: string): Promise<boolean>;
}

export interface AgentSecretServiceDependencies {
  store: Pick<RuntimeStore, "agentSecretRequests" | "conversation">;
  dataDirectory: string;
  turns: AgentSecretTurnWaits;
  broadcast(event: RuntimeMutationEvent): void;
  credentials?: AgentSecretVault;
  signal?: AbortSignal;
  clock?: () => number;
  platform?: NodeJS.Platform;
  waitMs?: (providerId: ProviderId) => number;
  sweepIntervalMs?: number;
}

export interface AgentSecretHostToolSource {
  conversation: Conversation;
  turn: AgentTurn;
}

export interface AgentSecretDelivery {
  conversationId: string;
  requestId: string;
  secret: string;
  vaulted: boolean;
}

export type AgentSecretDeliveryOutcome =
  | { status: "delivered"; expiresAt: string; storage: SecretRequestStorage }
  | { status: "rejected"; reason: RuntimeAgentSecretRejectionReason };

type WaitOutcome =
  | { kind: "saved"; file: string; expiresAt: string }
  | { kind: "declined" }
  | { kind: "ended"; reason: SecretRequestEndReason };

interface PendingRequest {
  conversationId: string;
  turnId: string;
  fileName: string;
  ttlHours: number;
  delivering: boolean;
  finish(outcome: WaitOutcome): void;
}

interface ActiveSecret {
  conversationId: string;
  token: string;
  expiresAtMs: number;
  value: string;
}

function rejected(reason: RuntimeAgentSecretRejectionReason): AgentSecretDeliveryOutcome {
  return { status: "rejected", reason };
}

export class AgentSecretService {
  readonly output = new SecretOutputRedactor();
  private readonly root: string;
  private readonly clock: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly active = new Map<string, ActiveSecret>();
  private restoring: AgentSecretRequestRecord[] = [];
  private expiryTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly dependencies: AgentSecretServiceDependencies) {
    this.root = agentSecretRoot(dependencies.dataDirectory);
    this.clock = dependencies.clock ?? Date.now;
    this.platform = dependencies.platform ?? process.platform;
    if (dependencies.signal?.aborted) this.closed = true;
    else dependencies.signal?.addEventListener("abort", () => this.shutdown(), { once: true });
  }

  private get repository() {
    return this.dependencies.store.agentSecretRequests();
  }

  start(): void {
    if (this.closed) return;
    try {
      ensureAgentSecretRoot(this.root);
    } catch {
    }
    clearAgentSecretRoot(this.root);
    for (const record of this.repository.pendingAll()) this.transition(record.id, ["pending"], "ended");
    const now = this.clock();
    for (const record of this.repository.activeSaved()) {
      if (Date.parse(record.expiresAt ?? "") <= now || !record.vaulted || !this.dependencies.credentials) {
        this.retire(record.id, "expired");
        continue;
      }
      this.restoring.push(record);
    }
    const interval = Math.max(1_000, this.dependencies.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    this.sweepTimer = setInterval(() => this.sweep(), interval);
    this.sweepTimer.unref?.();
  }

  async restore(): Promise<void> {
    const records = this.restoring.splice(0);
    for (const record of records) {
      if (this.closed) return;
      let value: string | null = null;
      try {
        value = await this.dependencies.credentials?.resolve(agentSecretReference(record.id)) ?? null;
      } catch {
        value = null;
      }
      if (this.closed) return;
      const current = this.repository.find(record.id);
      if (current?.status !== "saved" || current.fileToken === null) continue;
      const expiresAtMs = Date.parse(current.expiresAt ?? "");
      if (value === null || !isAgentSecretValue(value) || !(expiresAtMs > this.clock())) {
        this.retire(record.id, "expired");
        continue;
      }
      try {
        await writeAgentSecretFile(this.root, current.fileToken, current.fileName, value);
      } catch {
        this.retire(record.id, "expired");
        continue;
      }
      if (this.closed) {
        clearAgentSecretRoot(this.root);
        return;
      }
      this.active.set(record.id, {
        conversationId: current.conversationId,
        token: current.fileToken,
        expiresAtMs,
        value,
      });
      this.refreshActive();
    }
  }

  async invoke(source: AgentSecretHostToolSource, call: ProviderHostToolCall): Promise<ProviderHostToolResult> {
    const parsed = parseSecretRequestArguments(call.arguments);
    if (!parsed.ok) return parsed.failure;
    if (this.closed) return secretRequestEndedResult("stopped");
    if (call.signal.aborted) return secretRequestFailure("call_cancelled", "The secret request was cancelled.");
    if (this.activeCount() >= SECRET_REQUEST_MAX_ACTIVE) return secretRequestLimitFailure("active-limit");
    let created: AgentSecretRequestChange;
    try {
      created = this.repository.create({
        conversationId: source.conversation.id,
        runId: source.turn.runId,
        turnId: source.turn.id,
        providerId: source.turn.providerId,
        ...parsed.input,
        createdAt: new Date(this.clock()).toISOString(),
      });
    } catch (error) {
      if (error instanceof AgentSecretRequestError) return secretRequestLimitFailure(error.code);
      return secretRequestFailure("secret_request_not_saved", "Inertia could not open the secret request. Continue without it.");
    }
    this.publish(created.message);
    const requestId = created.request.id;
    const { conversationId, turnId } = created.request;
    const waitMs = Math.max(0, Math.min(MAX_TIMER_MS, (this.dependencies.waitMs ?? secretRequestWaitMs)(source.turn.providerId)));
    const outcome = await new Promise<WaitOutcome>((resolve) => {
      let settled = false;
      const onAbort = (): void => this.end(requestId, "cancelled");
      const timer = setTimeout(() => this.end(requestId, "timed_out"), waitMs);
      timer.unref?.();
      this.pending.set(requestId, {
        conversationId,
        turnId,
        fileName: created.request.fileName,
        ttlHours: created.request.ttlHours,
        delivering: false,
        finish: (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          call.signal.removeEventListener("abort", onAbort);
          this.pending.delete(requestId);
          resolve(value);
        },
      });
      call.signal.addEventListener("abort", onAbort, { once: true });
      if (call.signal.aborted) {
        this.end(requestId, "cancelled");
        return;
      }
      if (!this.secretWait(conversationId, turnId, requestId, created.request.title)) this.end(requestId, "cancelled");
    });
    this.secretWait(conversationId, turnId, requestId, null);
    switch (outcome.kind) {
      case "saved":
        return secretRequestSavedResult(requestId, outcome.file, outcome.expiresAt, this.platform);
      case "declined":
        return secretRequestDeclinedResult();
      case "ended":
        return secretRequestEndedResult(outcome.reason);
    }
  }

  async deliver(input: AgentSecretDelivery): Promise<AgentSecretDeliveryOutcome> {
    if (this.closed) return rejected("ended");
    const entry = this.pending.get(input.requestId);
    if (!entry || entry.conversationId !== input.conversationId || entry.delivering) return rejected("not-pending");
    if (!isAgentSecretValue(input.secret)) return rejected("file-failed");
    if (this.activeCount() >= SECRET_REQUEST_MAX_ACTIVE) return rejected("limit");
    entry.delivering = true;
    const token = newAgentSecretFileToken();
    let file: string;
    try {
      file = await writeAgentSecretFile(this.root, token, entry.fileName, input.secret);
    } catch {
      entry.delivering = false;
      return rejected("file-failed");
    }
    const now = this.clock();
    const expiresAtMs = now + entry.ttlHours * HOUR_MS;
    const expiresAt = new Date(expiresAtMs).toISOString();
    let change: AgentSecretRequestChange | null;
    try {
      change = this.repository.transition(input.requestId, ["pending"], "saved", {
        fileToken: token,
        expiresAt,
        vaulted: input.vaulted,
        answeredAt: new Date(now).toISOString(),
      });
    } catch (error) {
      this.removeFile(token);
      entry.delivering = false;
      return rejected(error instanceof AgentSecretRequestError ? "limit" : "file-failed");
    }
    if (!change || this.closed) {
      this.removeFile(token);
      return rejected("ended");
    }
    this.active.set(input.requestId, {
      conversationId: input.conversationId,
      token,
      expiresAtMs,
      value: input.secret,
    });
    this.refreshActive();
    this.publish(change.message);
    entry.finish({ kind: "saved", file, expiresAt });
    return { status: "delivered", expiresAt, storage: input.vaulted ? "keychain" : "memory" };
  }

  decline(conversationId: string, requestId: string): Promise<boolean> {
    const entry = this.pending.get(requestId);
    if (!entry || entry.conversationId !== conversationId) return Promise.resolve(false);
    if (!this.transition(requestId, ["pending"], "declined")) return Promise.resolve(false);
    entry.finish({ kind: "declined" });
    this.forgetVault(requestId);
    return Promise.resolve(true);
  }

  revoke(requestId: string): Promise<boolean> {
    const record = this.repository.find(requestId);
    if (record?.status !== "saved") return Promise.resolve(false);
    return Promise.resolve(this.retire(requestId, "revoked"));
  }

  revokeForConversation(conversationId: string): void {
    if (this.closed) return;
    const ids = new Set<string>();
    try {
      for (const record of this.repository.forConversation(conversationId)) {
        if (record.status === "saved") ids.add(record.id);
      }
    } catch {
    }
    for (const [requestId, secret] of this.active) {
      if (secret.conversationId === conversationId) ids.add(requestId);
    }
    if (ids.size === 0) return;
    for (const requestId of ids) {
      try {
        this.repository.transition(requestId, ["saved"], "revoked");
      } catch {
      }
      const secret = this.active.get(requestId);
      if (secret) {
        this.active.delete(requestId);
        this.removeFile(secret.token);
      }
      this.forgetVault(requestId);
    }
    this.refreshActive();
  }

  list(): SecretRequestListEntry[] {
    const now = this.clock();
    return this.repository.activeSaved()
      .filter((record) => record.answeredAt !== null && Date.parse(record.expiresAt ?? "") > now)
      .slice(0, SECRET_REQUEST_MAX_ACTIVE)
      .map((record) => ({
        requestId: record.id,
        conversationId: record.conversationId,
        conversationTitle: this.conversationTitle(record.conversationId),
        title: record.title,
        answeredAt: record.answeredAt!,
        expiresAt: record.expiresAt!,
        storage: record.vaulted ? "keychain" : "memory",
      }));
  }

  filePath(requestId: string): string | null {
    const secret = this.active.get(requestId);
    const record = secret ? this.repository.find(requestId) : null;
    return secret && record ? agentSecretFilePath(this.root, secret.token, record.fileName) : null;
  }

  sweep(): void {
    if (this.closed) return;
    this.expireDue();
    for (const [requestId, secret] of this.active) {
      if (this.repository.find(requestId)?.status === "saved") continue;
      this.active.delete(requestId);
      this.removeFile(secret.token);
      this.forgetVault(requestId);
    }
    this.refreshActive();
    clearAgentSecretRoot(this.root, new Set([...this.active.values()].map(({ token }) => token)));
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.expiryTimer = null;
    this.sweepTimer = null;
    this.restoring = [];
    for (const [requestId, entry] of this.pending) {
      try {
        this.repository.transition(requestId, ["pending"], "ended");
      } catch {
      }
      entry.finish({ kind: "ended", reason: "stopped" });
    }
    this.active.clear();
    this.output.setValues([]);
    clearAgentSecretRoot(this.root);
  }

  private activeCount(): number {
    try {
      return Math.max(this.active.size, this.repository.activeSaved().length);
    } catch {
      return this.active.size;
    }
  }

  private end(requestId: string, reason: SecretRequestEndReason): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.transition(requestId, ["pending"], "ended");
    entry.finish({ kind: "ended", reason });
    this.forgetVault(requestId);
  }

  private expireDue(): void {
    const now = this.clock();
    for (const [requestId, secret] of this.active) {
      if (secret.expiresAtMs <= now) this.retire(requestId, "expired");
    }
    for (const record of this.repository.activeSaved()) {
      if (Date.parse(record.expiresAt ?? "") <= now && !this.restoring.some(({ id }) => id === record.id)) {
        this.retire(record.id, "expired");
      }
    }
  }

  private retire(requestId: string, to: "expired" | "revoked"): boolean {
    const changed = this.transition(requestId, ["saved"], to);
    const secret = this.active.get(requestId);
    if (secret) {
      this.active.delete(requestId);
      this.removeFile(secret.token);
      this.refreshActive();
    }
    if (changed) this.forgetVault(requestId);
    return changed;
  }

  private transition(requestId: string, from: readonly SecretRequestStatus[], to: SecretRequestStatus): boolean {
    let change: AgentSecretRequestChange | null;
    try {
      change = this.repository.transition(requestId, from, to);
    } catch {
      return false;
    }
    if (!change) return false;
    this.publish(change.message);
    return true;
  }

  private refreshActive(): void {
    this.output.setValues([...this.active.values()].map(({ value }) => value));
    this.scheduleExpiry();
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.closed || this.active.size === 0) return;
    const soonest = Math.min(...[...this.active.values()].map(({ expiresAtMs }) => expiresAtMs));
    const delay = Math.max(0, Math.min(MAX_TIMER_MS, soonest - this.clock()));
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.expireDue();
      this.scheduleExpiry();
    }, delay);
    this.expiryTimer.unref?.();
  }

  private secretWait(conversationId: string, turnId: string, requestId: string, title: string | null): boolean {
    try {
      return this.dependencies.turns.secretWait(conversationId, turnId, requestId, title);
    } catch {
      return false;
    }
  }

  private removeFile(token: string): void {
    try {
      removeAgentSecretDirectory(this.root, token);
    } catch {
    }
  }

  private forgetVault(requestId: string): void {
    const credentials = this.dependencies.credentials;
    if (!credentials) return;
    void credentials.forget(agentSecretReference(requestId)).catch(() => undefined);
  }

  private conversationTitle(conversationId: string): string {
    try {
      return this.dependencies.store.conversation(conversationId).title.slice(0, 1_000);
    } catch {
      return "";
    }
  }

  private publish(message: ChatMessage): void {
    try {
      this.dependencies.broadcast({ type: "conversation.message.persisted", message });
    } catch {
    }
  }
}
