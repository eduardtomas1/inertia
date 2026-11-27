import { timingSafeEqual } from "node:crypto";

import {
  SECRET_REQUEST_MAX_ACTIVE,
  type SecretRequestStorage,
  type SecretRequestStatus,
} from "../../../shared/agent-secrets";
import {
  agentSecretReference,
  isAgentSecretValue,
  secretRequestWaitMs,
  SECRET_VALUE_EXPOSURE_MESSAGE,
} from "../../../node/agent-secrets";
import type { AgentTurn, ChatMessage, Conversation, RuntimeMutationEvent } from "../../../shared/contracts";
import type { SecretRequestListEntry } from "../../../shared/contracts/secret-request-results";
import type { ProviderId } from "../../../shared/provider";
import type { RuntimeAgentSecretRejectionReason } from "../../../node/runtime-agent-secret-protocol";
import type { RuntimeStore } from "../../database";
import {
  AgentSecretRequestError,
  type AgentSecretRequestChange,
  type AgentSecretRequestRecord,
} from "../../persistence/agent-secret-request-repository";
import type { ProviderHostToolCall, ProviderHostToolResult } from "../../provider/contracts";
import type { SecretRequestOpening, TurnSecretRequestWaits } from "../turns/turn-secret-output";
import {
  agentSecretFilePath,
  agentSecretRoot,
  clearAgentSecretRoot,
  ensureAgentSecretRoot,
  ensureAgentSecretRootAsync,
  newAgentSecretFileToken,
  readRetainedAgentSecretValues,
  removeAgentSecretDirectory,
  removeAgentSecretDirectoryAsync,
  retainedAgentSecretTokens,
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
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60_000;
const DEFAULT_RESTORE_WAIT_MS = 5_000;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_FORGET_RETRIES = 256;

export interface AgentSecretVault {
  resolve(secretReference: string): Promise<string | null>;
  forget(secretReference: string): Promise<boolean>;
}

export interface AgentSecretServiceDependencies {
  store: Pick<RuntimeStore, "transcriptRepository" | "conversation">;
  dataDirectory: string;
  turns: TurnSecretRequestWaits;
  broadcast(event: RuntimeMutationEvent): void;
  credentials?: AgentSecretVault;
  signal?: AbortSignal;
  clock?: () => number;
  platform?: NodeJS.Platform;
  waitMs?: (providerId: ProviderId) => number;
  sweepIntervalMs?: number;
  removeDirectory?: (root: string, token: string) => void;
  removeDirectoryAsync?: (root: string, token: string) => Promise<void>;
  writeFile?: typeof writeAgentSecretFile;
  ensureRoot?: typeof ensureAgentSecretRoot;
  ensureRootAsync?: typeof ensureAgentSecretRootAsync;
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

export type AgentSecretRevokeOutcome = "revoked" | "not-active" | "in-use";

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

function secretValuesEqual(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left, "utf8");
  const rightBuf = Buffer.from(right, "utf8");
  return leftBuf.length === rightBuf.length && timingSafeEqual(leftBuf, rightBuf);
}

export class AgentSecretService {
  readonly output = new SecretOutputRedactor();
  private readonly root: string;
  private readonly clock: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly active = new Map<string, ActiveSecret>();
  private readonly lingering = new Map<string, readonly string[]>();
  private readonly unhardenedRetainedTokens = new Set<string>();
  private readonly deletingUnhardenedTokens = new Map<string, Promise<boolean>>();
  private readonly restoringWrites = new Map<string, Promise<void>>();
  private readonly revokingCounts = new Map<string, number>();
  private readonly writing = new Map<string, string>();
  private readonly failedForgets = new Set<string>();
  private readonly restoringIds = new Set<string>();
  private readonly restoringActiveTokens = new Map<string, string>();
  private readonly restoringDeadlines = new Map<string, number>();
  private restoring: AgentSecretRequestRecord[] = [];
  private initialRestorePromise: Promise<void> | null = null;
  private hardeningSweepPromise: Promise<void> | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly dependencies: AgentSecretServiceDependencies) {
    this.root = agentSecretRoot(dependencies.dataDirectory);
    this.clock = dependencies.clock ?? Date.now;
    this.platform = dependencies.platform ?? process.platform;
    dependencies.turns.attachService?.({
      cancelForTurn: (conversationId, turnId, reason) => this.cancelForTurn(conversationId, turnId, reason),
      hasPending: (conversationId) => this.hasPending(conversationId),
    });
    if (dependencies.signal?.aborted) this.closed = true;
    else dependencies.signal?.addEventListener("abort", () => this.shutdown(), { once: true });
  }

  private get repository() {
    return this.dependencies.store.transcriptRepository.secretRequests;
  }

  start(): void {
    if (this.closed) return;
    try {
      // Defer Windows PowerShell DACL hardening for empty roots so cold runtime
      // startup stays fast when no secrets exist; recoverRetainedFiles() hardens
      // before retaining any surviving plaintext files and writeAgentSecretFile()
      // always hardens before writing.
      this.ensureRoot(this.root, { platform: this.platform, hardenWindowsDacl: false });
    } catch {
    }
    try {
      this.settleStoredRequests();
    } catch {
      this.restoring = [];
    }
    this.recoverRetainedFiles();
    const interval = Math.max(1_000, this.dependencies.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    this.sweepTimer = setInterval(() => this.sweep(), interval);
    this.sweepTimer.unref?.();
  }

  private ensureRoot(root: string, options?: Parameters<typeof ensureAgentSecretRoot>[1]): void {
    (this.dependencies.ensureRoot ?? ensureAgentSecretRoot)(root, options);
  }

  private ensureRootAsync(root: string, options?: Parameters<typeof ensureAgentSecretRootAsync>[1]): Promise<void> {
    return (this.dependencies.ensureRootAsync ?? ensureAgentSecretRootAsync)(root, options);
  }

  private recoverRetainedFiles(): void {
    const restoringTokens = this.restoringTokens();
    const retainedTokens = retainedAgentSecretTokens(this.root);
    let hardeningResult: boolean | null = null;
    const ensureHardened = (): boolean => {
      if (hardeningResult !== null) return hardeningResult;
      try {
        this.ensureRoot(this.root, { platform: this.platform, hardenWindowsDacl: true });
        hardeningResult = true;
      } catch {
        hardeningResult = false;
      }
      return hardeningResult;
    };
    for (const token of retainedTokens) {
      if (restoringTokens.has(token)) {
        if (ensureHardened()) {
          const values = readRetainedAgentSecretValues(this.root, token, this.platform);
          if (values.length > 0) this.lingering.set(token, values);
          continue;
        }
        // Do not keep surviving plaintext under a potentially permissive ACL if
        // hardening failed; remove it now (restore recreates it once hardening works).
        if (this.removeFile(token)) continue;
        this.unhardenedRetainedTokens.add(token);
        this.lingering.set(token, readRetainedAgentSecretValues(this.root, token, this.platform));
        continue;
      }
      if (this.removeFile(token)) continue;
      if (!ensureHardened()) this.unhardenedRetainedTokens.add(token);
      this.lingering.set(token, readRetainedAgentSecretValues(this.root, token, this.platform));
    }
    clearAgentSecretRoot(this.root, new Set([...this.lingering.keys(), ...restoringTokens]));
    this.refreshActive();
  }

  private settleStoredRequests(): void {
    for (const record of this.repository.pendingAll()) {
      this.transition(record.id, ["pending"], "ended");
      this.forgetVault(record.id);
    }
    const now = this.clock();
    for (const record of this.repository.activeSaved()) {
      if (Date.parse(record.expiresAt ?? "") <= now || !record.vaulted || !this.dependencies.credentials) {
        this.retire(record.id, "expired");
        continue;
      }
      this.restoring.push(record);
    }
  }

  restore(): Promise<void> {
    const run = this.runRestore();
    this.initialRestorePromise ??= run;
    return run;
  }

  async whenRestored(timeoutMs = DEFAULT_RESTORE_WAIT_MS): Promise<void> {
    const pending = this.initialRestorePromise;
    if (!pending || this.closed) return;
    const bounded = Math.max(0, Math.min(MAX_TIMER_MS, timeoutMs));
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        pending.catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, bounded);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async runRestore(): Promise<void> {
    const records = this.restoring.splice(0);
    for (const record of records) {
      const deadline = Date.parse(record.expiresAt ?? "");
      if (Number.isFinite(deadline)) this.restoringDeadlines.set(record.id, deadline);
    }
    this.scheduleExpiry();
    const retry: AgentSecretRequestRecord[] = [];
    for (const record of records) {
      if (this.closed) return;
      if (this.restoringIds.has(record.id)) continue;
      const recordExpiresAtMs = Date.parse(record.expiresAt ?? "");
      if (!(recordExpiresAtMs > this.clock())) {
        this.retire(record.id, "expired", record.fileToken);
        continue;
      }
      this.restoringIds.add(record.id);
      if (record.fileToken) this.restoringActiveTokens.set(record.id, record.fileToken);
      let queuedForRetry = false;
      try {
        let value: string | null;
        try {
          value = await this.dependencies.credentials?.resolve(agentSecretReference(record.id)) ?? null;
        } catch {
          if (this.closed) return;
          if (!(recordExpiresAtMs > this.clock())) {
            this.retire(record.id, "expired", record.fileToken);
          } else {
            retry.push(record);
            queuedForRetry = true;
          }
          continue;
        }
        if (this.closed) return;
        const current = this.repository.find(record.id);
        if (current?.status !== "saved" || current.fileToken === null) {
          if (record.fileToken && !this.tokenInActiveUse(record.fileToken)) {
            this.discardRetainedFile(record.fileToken);
            this.refreshActive();
          }
          continue;
        }
        const expiresAtMs = Date.parse(current.expiresAt ?? "");
        if (value === null || !isAgentSecretValue(value) || !(expiresAtMs > this.clock())) {
          this.retire(record.id, "expired", current.fileToken);
          continue;
        }
        const token = current.fileToken;
        if (this.isRevoking(record.id)) {
          retry.push(record);
          queuedForRetry = true;
          continue;
        }
        this.active.set(record.id, { conversationId: current.conversationId, token, expiresAtMs, value });
        this.refreshActive();
        const pendingDelete = this.deletingUnhardenedTokens.get(token);
        if (pendingDelete) {
          await pendingDelete;
          if (this.closed) return;
          if (this.isRevoking(record.id)) {
            if (this.active.get(record.id)?.token === token) this.active.delete(record.id);
            this.refreshActive();
            retry.push(record);
            queuedForRetry = true;
            continue;
          }
          if (this.active.get(record.id)?.token !== token) continue;
        }
        let writeFailed = false;
        let writeTask: Promise<void> | undefined;
        // Keep the restore secret in `this.writing` until the write and any
        // post-write retirement cleanup settle so TTL expiry cannot drop
        // redaction while the writer is still publishing the file (S23).
        this.writing.set(token, value);
        this.refreshActive();
        writeTask = (async () => {
          try {
            await this.writeFile(token, current.fileName, value);
          } catch {
            writeFailed = true;
          } finally {
            if (this.restoringWrites.get(token) === writeTask) {
              this.restoringWrites.delete(token);
            }
          }
        })();
        this.restoringWrites.set(token, writeTask);
        await writeTask;
        this.writing.delete(token);
        if (writeFailed) {
          if (this.closed) return;
          if (this.isRevoking(record.id) && this.active.get(record.id)?.token === token) {
            this.active.delete(record.id);
            this.lingering.set(token, [value]);
            this.refreshActive();
            continue;
          }
          if (this.active.get(record.id)?.token !== token) {
            this.discardFile(token, value);
            this.refreshActive();
            continue;
          }
          this.retire(record.id, "expired", token);
          continue;
        }
        if (this.closed) {
          clearAgentSecretRoot(this.root);
          return;
        }
        if (this.active.get(record.id)?.token !== token) {
          this.discardFile(token, value);
        } else {
          this.lingering.delete(token);
          this.unhardenedRetainedTokens.delete(token);
        }
        this.refreshActive();
      } finally {
        this.restoringIds.delete(record.id);
        this.restoringActiveTokens.delete(record.id);
        if (!queuedForRetry) this.restoringDeadlines.delete(record.id);
        this.scheduleExpiry();
      }
    }
    if (!this.closed && retry.length > 0) {
      const now = this.clock();
      for (const record of retry) {
        this.restoringDeadlines.delete(record.id);
        if (!(Date.parse(record.expiresAt ?? "") > now)) {
          this.retire(record.id, "expired", record.fileToken);
          continue;
        }
        try {
          if (this.repository.find(record.id)?.status !== "saved") continue;
        } catch {
        }
        if (!this.restoring.some(({ id }) => id === record.id)) {
          this.restoring.push(record);
        }
      }
      this.scheduleExpiry();
    }
  }

  pendingConversationIds(): Set<string> {
    return new Set([...this.pending.values()].map(({ conversationId }) => conversationId));
  }

  hasPending(conversationId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.conversationId === conversationId) return true;
    }
    return false;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  cancelForTurn(conversationId: string, turnId: string, reason: SecretRequestEndReason = "stopped"): void {
    for (const [requestId, entry] of Array.from(this.pending)) {
      if (entry.conversationId === conversationId && entry.turnId === turnId) {
        this.end(requestId, reason);
      }
    }
  }

  containsSecret(value: unknown): boolean {
    return this.output.payload(value) !== value;
  }

  async invoke(source: AgentSecretHostToolSource, call: ProviderHostToolCall): Promise<ProviderHostToolResult> {
    if (this.containsSecret(call.arguments)) return secretRequestFailure("secret_value_not_allowed", SECRET_VALUE_EXPOSURE_MESSAGE);
    const parsed = parseSecretRequestArguments(call.arguments);
    if (!parsed.ok) return parsed.failure;
    if (this.closed) return secretRequestEndedResult("stopped");
    if (call.signal.aborted) return secretRequestFailure("call_cancelled", "The secret request was cancelled.");
    if (this.activeCount() >= SECRET_REQUEST_MAX_ACTIVE) return secretRequestLimitFailure("active-limit");
    const opening = this.openRequest(source.conversation.id, source.turn.id);
    let created: AgentSecretRequestChange;
    try {
      created = this.repository.create({
        conversationId: source.conversation.id,
        runId: source.turn.runId,
        turnId: source.turn.id,
        providerId: source.turn.providerId,
        ...parsed.input,
        createdAt: this.cardCreatedAt(opening),
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
      if (!this.secretWait(conversationId, turnId, requestId, created.request.title, created.request.createdAt)) {
        this.end(requestId, "cancelled");
        return;
      }
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
    if (!entry) {
      const existing = this.active.get(input.requestId);
      if (existing && existing.conversationId === input.conversationId && secretValuesEqual(existing.value, input.secret)) {
        const record = this.repository.find(input.requestId);
        if (record?.status === "saved" && record.expiresAt) {
          return { status: "delivered", expiresAt: record.expiresAt, storage: record.vaulted ? "keychain" : "memory" };
        }
      }
      return rejected("not-pending");
    }
    if (entry.conversationId !== input.conversationId || entry.delivering) return rejected("not-pending");
    if (!isAgentSecretValue(input.secret)) return rejected("invalid");
    if (this.activeCount() >= SECRET_REQUEST_MAX_ACTIVE) return rejected("limit");
    entry.delivering = true;
    const token = newAgentSecretFileToken();
    this.writing.set(token, input.secret);
    this.refreshActive();
    let file: string;
    try {
      file = await this.writeFile(token, entry.fileName, input.secret);
    } catch {
      this.abandonWrite(token, input.secret);
      entry.delivering = false;
      return rejected(this.closed ? "ended" : "file-failed");
    }
    if (this.closed) {
      this.abandonWrite(token, input.secret);
      entry.delivering = false;
      return rejected("ended");
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
      this.abandonWrite(token, input.secret);
      entry.delivering = false;
      return rejected(error instanceof AgentSecretRequestError ? "limit" : "file-failed");
    }
    if (!change || this.closed) {
      this.abandonWrite(token, input.secret);
      return rejected("ended");
    }
    this.active.set(input.requestId, {
      conversationId: input.conversationId,
      token,
      expiresAtMs,
      value: input.secret,
    });
    this.writing.delete(token);
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

  async revoke(requestId: string): Promise<AgentSecretRevokeOutcome> {
    const record = this.repository.find(requestId);
    if (record?.status !== "saved") return "not-active";
    const token = this.active.get(requestId)?.token ?? record.fileToken;
    if (!token) {
      return this.retire(requestId, "revoked", null) ? "revoked" : "not-active";
    }
    this.beginRevoking(requestId);
    try {
      while (true) {
        const pendingWrite = this.restoringWrites.get(token);
        if (pendingWrite) {
          await pendingWrite;
          if (this.closed || this.repository.find(requestId)?.status !== "saved") return "not-active";
          continue;
        }
        if (this.deletingUnhardenedTokens.has(token) || this.unhardenedRetainedTokens.has(token)) {
          const removed = await this.startUnhardenedRemoval(token);
          if (this.closed || this.repository.find(requestId)?.status !== "saved") return "not-active";
          if (!removed) return "in-use";
          return this.retire(requestId, "revoked", token, true) ? "revoked" : "not-active";
        }
        if (!this.removeFile(token)) return "in-use";
        return this.retire(requestId, "revoked", token, true) ? "revoked" : "not-active";
      }
    } finally {
      this.endRevoking(requestId);
    }
  }

  private isRevoking(requestId: string): boolean {
    return (this.revokingCounts.get(requestId) ?? 0) > 0;
  }

  private beginRevoking(requestId: string): void {
    this.revokingCounts.set(requestId, (this.revokingCounts.get(requestId) ?? 0) + 1);
  }

  private endRevoking(requestId: string): void {
    const remaining = (this.revokingCounts.get(requestId) ?? 0) - 1;
    if (remaining > 0) this.revokingCounts.set(requestId, remaining);
    else this.revokingCounts.delete(requestId);
  }

  revokeForConversation(conversationId: string): void {
    if (this.closed) return;
    const savedTokens = new Map<string, string | null>();
    const pendingIds = new Set<string>();
    try {
      for (const record of this.repository.forConversation(conversationId)) {
        if (record.status === "saved") savedTokens.set(record.id, record.fileToken);
        else if (record.status === "pending") pendingIds.add(record.id);
      }
    } catch {
    }
    for (const [requestId, entry] of this.pending) {
      if (entry.conversationId === conversationId) pendingIds.add(requestId);
    }
    for (const requestId of pendingIds) {
      try {
        this.repository.transition(requestId, ["pending"], "ended");
      } catch {
      }
      this.pending.get(requestId)?.finish({ kind: "ended", reason: "cancelled" });
      this.forgetVault(requestId);
    }
    this.restoring = this.restoring.filter((record) => {
      if (record.conversationId !== conversationId) return true;
      savedTokens.set(record.id, record.fileToken ?? savedTokens.get(record.id) ?? null);
      return false;
    });
    for (const [requestId, secret] of this.active) {
      if (secret.conversationId === conversationId) savedTokens.set(requestId, secret.token);
    }
    if (savedTokens.size === 0) return;
    for (const [requestId, fileToken] of savedTokens) {
      try {
        this.repository.transition(requestId, ["saved"], "revoked");
      } catch {
      }
      if (this.active.has(requestId)) {
        this.release(requestId);
      } else if (fileToken && !this.tokenInActiveUse(fileToken)) {
        this.discardRetainedFile(fileToken);
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

  orphanedVaultRequests(requestIds: readonly string[]): string[] {
    if (this.closed) return [];
    try {
      return requestIds.filter((requestId) => {
        if (this.pending.has(requestId)) return false;
        const record = this.repository.find(requestId);
        if (record?.status === "saved" && !record.vaulted) return true;
        if (this.active.has(requestId)) return false;
        return record?.status !== "pending" && record?.status !== "saved";
      });
    } catch {
      return [];
    }
  }

  sweep(): void {
    if (this.closed) return;
    const retries = Array.from(this.failedForgets);
    this.failedForgets.clear();
    for (const requestId of retries) this.forgetVault(requestId);
    try {
      this.expireDue();
      for (const requestId of this.active.keys()) {
        if (this.repository.find(requestId)?.status === "saved") continue;
        this.release(requestId);
        this.forgetVault(requestId);
      }
    } catch {
    }
    const activeOrWriting = this.activeOrWritingTokens();
    const restoringTokens = this.restoringTokens();
    if (this.unhardenedRetainedTokens.size > 0) {
      void this.reconcileUnhardenedRetained(activeOrWriting);
    }
    for (const token of this.lingering.keys()) {
      if (
        restoringTokens.has(token)
        || this.unhardenedRetainedTokens.has(token)
        || this.deletingUnhardenedTokens.has(token)
      ) {
        continue;
      }
      if (activeOrWriting.has(token) || this.removeFile(token)) {
        this.lingering.delete(token);
      }
    }
    this.refreshActive();
    clearAgentSecretRoot(
      this.root,
      new Set([
        ...activeOrWriting,
        ...restoringTokens,
        ...this.lingering.keys(),
        ...this.unhardenedRetainedTokens,
        ...this.deletingUnhardenedTokens.keys(),
      ]),
    );
    if (this.restoring.length > 0) void this.restore();
  }

  private activeOrWritingTokens(): Set<string> {
    return new Set([
      ...[...this.active.values()].map(({ token }) => token),
      ...this.writing.keys(),
    ]);
  }

  private startUnhardenedRemoval(token: string): Promise<boolean> {
    const existing = this.deletingUnhardenedTokens.get(token);
    if (existing) return existing;
    let task: Promise<boolean> | undefined;
    task = (async () => {
      try {
        const removed = await this.removeFileAsync(token);
        if (this.closed || !removed) return removed;
        this.unhardenedRetainedTokens.delete(token);
        if (this.lingering.delete(token)) this.refreshActive();
        return true;
      } finally {
        if (this.deletingUnhardenedTokens.get(token) === task) {
          this.deletingUnhardenedTokens.delete(token);
        }
      }
    })();
    this.deletingUnhardenedTokens.set(token, task);
    return task;
  }

  private async reconcileUnhardenedRetained(activeOrWriting: ReadonlySet<string>): Promise<void> {
    const candidates = Array.from(this.unhardenedRetainedTokens).filter(
      (token) => !activeOrWriting.has(token) && !this.deletingUnhardenedTokens.has(token),
    );
    const promises = candidates.map((token) => this.startUnhardenedRemoval(token));
    if (promises.length > 0) await Promise.all(promises);
    if (
      this.closed
      || this.unhardenedRetainedTokens.size === 0
      || this.deletingUnhardenedTokens.size > 0
      || this.hardeningSweepPromise
    ) {
      return;
    }
    const pendingHardening = this.ensureRootAsync(this.root, {
      platform: this.platform,
      hardenWindowsDacl: true,
    })
      .then(() => {
        if (!this.closed) this.unhardenedRetainedTokens.clear();
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.hardeningSweepPromise === pendingHardening) {
          this.hardeningSweepPromise = null;
        }
      });
    this.hardeningSweepPromise = pendingHardening;
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.expiryTimer = null;
    this.sweepTimer = null;
    this.restoring = [];
    this.restoringActiveTokens.clear();
    this.restoringDeadlines.clear();
    for (const [requestId, entry] of this.pending) {
      try {
        this.repository.transition(requestId, ["pending"], "ended");
      } catch {
      }
      entry.finish({ kind: "ended", reason: "stopped" });
      this.forgetVault(requestId);
    }
    this.active.clear();
    this.lingering.clear();
    this.unhardenedRetainedTokens.clear();
    this.deletingUnhardenedTokens.clear();
    this.restoringWrites.clear();
    this.revokingCounts.clear();
    this.hardeningSweepPromise = null;
    this.writing.clear();
    this.output.setValues([]);
    clearAgentSecretRoot(this.root);
  }

  private restoringTokens(): Set<string> {
    const tokens = new Set<string>(this.restoringActiveTokens.values());
    for (const record of this.restoring) {
      if (record.fileToken) tokens.add(record.fileToken);
    }
    return tokens;
  }

  private tokenInActiveUse(token: string): boolean {
    if (this.writing.has(token)) return true;
    for (const secret of this.active.values()) {
      if (secret.token === token) return true;
    }
    return false;
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
      if (secret.expiresAtMs <= now) this.retire(requestId, "expired", secret.token);
    }
    for (const record of this.repository.activeSaved()) {
      if (!(Date.parse(record.expiresAt ?? "") > now)) {
        this.retire(record.id, "expired", record.fileToken);
      }
    }
  }

  private retire(
    requestId: string,
    to: "expired" | "revoked",
    fileToken?: string | null,
    fileAlreadyRemoved = false,
  ): boolean {
    const changed = this.transition(requestId, ["saved"], to);
    this.restoring = this.restoring.filter(({ id }) => id !== requestId);
    this.restoringActiveTokens.delete(requestId);
    this.restoringDeadlines.delete(requestId);
    if (fileAlreadyRemoved) {
      this.active.delete(requestId);
      if (fileToken) this.lingering.delete(fileToken);
      this.refreshActive();
    } else if (this.active.has(requestId)) {
      this.release(requestId);
      this.refreshActive();
    } else if (fileToken && !this.tokenInActiveUse(fileToken)) {
      this.discardRetainedFile(fileToken);
      this.refreshActive();
    }
    if (changed) this.forgetVault(requestId);
    return changed;
  }

  private discardRetainedFile(token: string): void {
    if (!this.closed && (this.unhardenedRetainedTokens.has(token) || this.deletingUnhardenedTokens.has(token))) {
      if (!this.lingering.has(token)) {
        const values = readRetainedAgentSecretValues(this.root, token, this.platform);
        if (values.length > 0) this.lingering.set(token, values);
      }
      void this.reconcileUnhardenedRetained(this.activeOrWritingTokens());
      return;
    }
    if (this.removeFile(token)) {
      this.lingering.delete(token);
      return;
    }
    if (!this.closed && !this.lingering.has(token)) {
      const values = readRetainedAgentSecretValues(this.root, token, this.platform);
      if (values.length > 0) this.lingering.set(token, values);
    }
  }

  private release(requestId: string): void {
    const secret = this.active.get(requestId);
    if (!secret) return;
    this.active.delete(requestId);
    this.discardFile(secret.token, secret.value);
  }

  private abandonWrite(token: string, value: string): void {
    this.writing.delete(token);
    this.discardFile(token, value);
    this.refreshActive();
  }

  private discardFile(token: string, value: string): void {
    if (this.closed) {
      this.removeFile(token);
      return;
    }
    if (this.unhardenedRetainedTokens.has(token) || this.deletingUnhardenedTokens.has(token)) {
      this.lingering.set(token, [value]);
      void this.reconcileUnhardenedRetained(this.activeOrWritingTokens());
      return;
    }
    if (!this.removeFile(token)) this.lingering.set(token, [value]);
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
    if (this.closed) return;
    this.output.setValues([
      ...[...this.active.values()].map(({ value }) => value),
      ...this.writing.values(),
      ...[...this.lingering.values()].flat(),
    ]);
    this.scheduleExpiry();
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.closed) return;
    const deadlines = [
      ...[...this.active.values()].map(({ expiresAtMs }) => expiresAtMs),
      ...this.restoring.map(({ expiresAt }) => Date.parse(expiresAt ?? "")).filter(Number.isFinite),
      ...this.restoringDeadlines.values(),
    ];
    if (deadlines.length === 0) return;
    const soonest = Math.min(...deadlines);
    const delay = Math.max(0, Math.min(MAX_TIMER_MS, soonest - this.clock()));
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      try {
        this.expireDue();
      } catch {
      }
      this.scheduleExpiry();
    }, delay);
    this.expiryTimer.unref?.();
  }

  private secretWait(
    conversationId: string,
    turnId: string,
    requestId: string,
    title: string | null,
    cardCreatedAt?: string,
  ): boolean {
    try {
      return this.dependencies.turns.wait(conversationId, turnId, requestId, title, cardCreatedAt);
    } catch {
      return false;
    }
  }

  private openRequest(conversationId: string, turnId: string): SecretRequestOpening | null {
    try {
      return this.dependencies.turns.open(conversationId, turnId);
    } catch {
      return null;
    }
  }

  private cardCreatedAt(opening: SecretRequestOpening | null): string {
    const notBefore = opening?.notBefore ? Date.parse(opening.notBefore) + 1 : Number.NaN;
    return new Date(Number.isFinite(notBefore) ? Math.max(this.clock(), notBefore) : this.clock()).toISOString();
  }

  private writeFile(token: string, fileName: string, value: string): Promise<string> {
    return (this.dependencies.writeFile ?? writeAgentSecretFile)(this.root, token, fileName, value);
  }

  private removeFile(token: string): boolean {
    try {
      (this.dependencies.removeDirectory ?? removeAgentSecretDirectory)(this.root, token);
      this.unhardenedRetainedTokens.delete(token);
      return true;
    } catch {
      return false;
    }
  }

  private async removeFileAsync(token: string): Promise<boolean> {
    try {
      if (this.dependencies.removeDirectoryAsync) {
        await this.dependencies.removeDirectoryAsync(this.root, token);
      } else if (this.dependencies.removeDirectory) {
        await Promise.resolve();
        this.dependencies.removeDirectory(this.root, token);
      } else {
        await removeAgentSecretDirectoryAsync(this.root, token);
      }
      this.unhardenedRetainedTokens.delete(token);
      return true;
    } catch {
      return false;
    }
  }

  private forgetVault(requestId: string): void {
    const credentials = this.dependencies.credentials;
    if (!credentials) return;
    this.failedForgets.delete(requestId);
    const retry = (): void => {
      if (this.failedForgets.size < MAX_FORGET_RETRIES) this.failedForgets.add(requestId);
    };
    try {
      void credentials.forget(agentSecretReference(requestId)).catch(retry);
    } catch {
      retry();
    }
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
