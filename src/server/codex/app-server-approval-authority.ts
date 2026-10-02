import { codexApprovalResult, type ParsedCodexApprovalRequest } from "./approvals";
import { CODEX_RPC_TIMEOUT_MS, type CodexRunPhase } from "./app-server-config";
import type { CodexSubagentLifecycle } from "./app-server-subagents";
import {
  MAX_PRE_RESPONSE_TURN_NOTIFICATIONS,
  PreResponseTurnNotifications,
} from "./pre-response-turn-notifications";
import type { JsonObject, RpcId } from "./protocol";

const UNOWNED_APPROVAL_MESSAGE = "Codex sent an approval outside the exact owned provider turn.";

interface ApprovalOwner {
  providerThreadId: string;
  providerTurnId?: string;
}

interface DeferredApproval extends Required<ApprovalOwner> {
  rpcId: RpcId;
  method: string;
  params: JsonObject;
  protocol: ParsedCodexApprovalRequest["protocol"];
  beforeStartResponse: boolean;
  timer: NodeJS.Timeout;
}

interface CodexApprovalAuthorityHost {
  providerThreadId: () => string | undefined;
  activeTurnId: () => string | undefined;
  phase: () => CodexRunPhase;
  requestedTurnId?: () => string | null | undefined;
  cancelRequested: () => boolean;
  completedTurnIds: ReadonlySet<string>;
  subagents: Pick<CodexSubagentLifecycle,
    "isOwnedProviderThread" | "isOwnedProviderTurn" | "isAwaitingChildTurn">;
  reserveServerRequest: (id: RpcId) => boolean;
  releaseServerRequest: (id: RpcId) => void;
  handleServerRequest: (id: RpcId, method: string, params: JsonObject) => void;
  handleNotification: (method: string, params: JsonObject) => void;
  writeMessage: (message: JsonObject) => boolean;
  failMalformedProtocol: (summary: string, message: string) => void;
}

export class CodexApprovalAuthority {
  private readonly deferred = new Map<RpcId, DeferredApproval>();
  private readonly preResponse = new PreResponseTurnNotifications();

  constructor(private readonly host: CodexApprovalAuthorityHost) {}

  admit(
    id: RpcId,
    method: string,
    params: JsonObject,
    approval: ParsedCodexApprovalRequest,
  ): approval is ParsedCodexApprovalRequest & { providerThreadId: string } {
    const { providerThreadId, providerTurnId } = approval;
    if (
      !providerThreadId
      || !this.host.subagents.isOwnedProviderThread(providerThreadId)
      || (approval.protocol !== "legacy-review" && !providerTurnId)
    ) {
      this.reject(id, providerThreadId && !this.host.subagents.isOwnedProviderThread(providerThreadId)
        ? "Codex sent an approval for a different provider thread."
        : undefined);
      return false;
    }
    if (this.host.cancelRequested()) {
      this.host.writeMessage({ id, result: codexApprovalResult(approval.protocol, "cancel") });
      return false;
    }
    if (approval.protocol !== "legacy-review" && providerTurnId) {
      const beforeStartResponse = providerThreadId === this.host.providerThreadId()
        && this.host.phase() === "starting-turn"
        && this.host.requestedTurnId?.() === null;
      if (beforeStartResponse || this.host.subagents.isAwaitingChildTurn(providerThreadId, providerTurnId)) {
        this.defer(id, method, params, approval.protocol, providerThreadId, providerTurnId, beforeStartResponse);
        return false;
      }
      if (!this.owns({ providerThreadId, providerTurnId })) {
        this.refuse(id);
        return false;
      }
    }
    return true;
  }

  owns(owner: ApprovalOwner): boolean {
    if (!owner.providerTurnId) return this.host.subagents.isOwnedProviderThread(owner.providerThreadId);
    if (owner.providerThreadId === this.host.providerThreadId()) {
      if (this.host.completedTurnIds.has(owner.providerTurnId)) return false;
      if (this.host.phase() === "starting-turn") {
        return this.host.requestedTurnId?.() === owner.providerTurnId;
      }
    }
    return this.host.subagents.isOwnedProviderTurn(owner.providerThreadId, owner.providerTurnId);
  }

  refuse(id: RpcId, message = UNOWNED_APPROVAL_MESSAGE): void {
    this.host.writeMessage({ id, error: { code: -32602, message } });
  }

  private reject(id: RpcId, message = UNOWNED_APPROVAL_MESSAGE): void {
    this.refuse(id, message);
    this.host.failMalformedProtocol(message, message);
  }

  holdNotification(
    method: string,
    threadId: string | undefined,
    turnId: string | undefined,
    params: JsonObject,
  ): boolean {
    if (
      !turnId
      || this.host.phase() !== "starting-turn"
      || this.host.requestedTurnId?.() !== null
      || threadId !== this.host.providerThreadId()
      || this.host.completedTurnIds.has(turnId)
      || turnId === this.host.activeTurnId()
    ) return false;
    if (!this.preResponse.hold(method, turnId, params)) {
      this.host.failMalformedProtocol(
        "Codex sent too many notifications before the turn/start response.",
        `Codex exceeded the ${MAX_PRE_RESPONSE_TURN_NOTIFICATIONS}-notification limit before the turn/start response.`,
      );
    }
    return true;
  }

  replayPreResponse(turnId: string): void {
    for (const { method, params, requestId } of this.preResponse.take(turnId)) {
      if (requestId === undefined) this.host.handleNotification(method, params);
      else this.replay(requestId);
    }
  }

  replayChildApprovals(): void {
    for (const pending of this.deferred.values()) {
      if (!pending.beforeStartResponse && !this.host.subagents.isAwaitingChildTurn(
        pending.providerThreadId, pending.providerTurnId,
      )) this.replay(pending.rpcId);
    }
  }

  resolveRequest(id: RpcId): boolean {
    const pending = this.deferred.get(id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.preResponse.removeRequest(id);
    this.deferred.delete(id);
    this.host.releaseServerRequest(id);
    return true;
  }

  clear(): void {
    for (const pending of this.deferred.values()) {
      clearTimeout(pending.timer);
      this.host.releaseServerRequest(pending.rpcId);
      this.host.writeMessage({ id: pending.rpcId, result: codexApprovalResult(pending.protocol, "cancel") });
    }
    this.deferred.clear();
    this.preResponse.clear();
  }

  private defer(
    rpcId: RpcId,
    method: string,
    params: JsonObject,
    protocol: ParsedCodexApprovalRequest["protocol"],
    providerThreadId: string,
    providerTurnId: string,
    beforeStartResponse: boolean,
  ): void {
    if (!this.host.reserveServerRequest(rpcId)) return;
    const timer = setTimeout(() => {
      this.deferred.delete(rpcId);
      this.host.releaseServerRequest(rpcId);
      this.refuse(rpcId);
    }, CODEX_RPC_TIMEOUT_MS);
    timer.unref();
    this.deferred.set(rpcId, {
      rpcId, method, params, protocol, providerThreadId, providerTurnId, beforeStartResponse, timer,
    });
    if (beforeStartResponse && !this.preResponse.hold(method, providerTurnId, params, rpcId)) {
      this.host.failMalformedProtocol("Codex sent too many updates before the turn/start response.",
        `Codex exceeded the ${MAX_PRE_RESPONSE_TURN_NOTIFICATIONS}-notification limit before the turn/start response.`);
    }
  }

  private replay(rpcId: RpcId): void {
    const pending = this.deferred.get(rpcId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.deferred.delete(rpcId);
    this.host.releaseServerRequest(rpcId);
    this.host.handleServerRequest(rpcId, pending.method, pending.params);
  }
}
