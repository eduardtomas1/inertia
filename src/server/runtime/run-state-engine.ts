import type {
  AgentRunState,
  AgentRunStateSnapshot,
  AgentRunTerminalState,
  ProviderId,
} from "../../shared/contracts";

export interface AuthoritativeRunIdentity {
  conversationId: string;
  runId: string;
  turnId: string;
  providerId: ProviderId;
}

type TransportRunState =
  | "queued"
  | "starting"
  | "running"
  | "delegated"
  | "retrying";

function boundedProviderState(value: string | null | undefined): string | null {
  const normalized = value
    ?.replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized ? normalized.slice(0, 200) : null;
}

/**
 * One exact-owner reducer for a live root run. Provider transports contribute
 * evidence, while root settlement remains a separate authoritative action.
 * Descendant, retry, and interaction signals can refine a live phase but can
 * never complete or revive the root run.
 */
export class AuthoritativeRunStateEngine {
  readonly identity: AuthoritativeRunIdentity;

  private transport: TransportRunState = "queued";
  private approvals = 0;
  private inputs = 0;
  private preferredInteraction: "approval" | "input" | null = null;
  private readonly liveDescendants = new Set<string>();
  private cancellationObserved = false;
  private requestedTerminal: AgentRunTerminalState | null = null;
  private terminal: AgentRunTerminalState | null = null;
  private quarantined = false;
  private current: AgentRunStateSnapshot = {
    state: "queued",
    providerState: null,
    revision: 0,
  };

  constructor(identity: AuthoritativeRunIdentity) {
    this.identity = { ...identity };
  }

  snapshot(): AgentRunStateSnapshot {
    return { ...this.current };
  }

  isTerminal(): boolean {
    return this.terminal !== null;
  }

  acceptsProviderEvents(): boolean {
    return !this.quarantined
      && this.terminal === null
      && this.requestedTerminal === null
      && !this.cancellationObserved;
  }

  terminalRequest(): AgentRunTerminalState | null {
    return this.requestedTerminal;
  }

  setTransport(
    state: TransportRunState,
    providerState?: string | null,
  ): boolean {
    if (!this.acceptsProviderEvents()) return false;
    this.transport = state;
    return this.refresh(providerState);
  }

  synchronizeInteractions(
    approvalCount: number,
    inputCount: number,
    providerState?: string | null,
    preferred?: "approval" | "input",
  ): boolean {
    if (!this.acceptsProviderEvents()) return false;
    this.approvals = Math.max(0, approvalCount);
    this.inputs = Math.max(0, inputCount);
    if (preferred === "approval" && this.approvals > 0) {
      this.preferredInteraction = "approval";
    } else if (preferred === "input" && this.inputs > 0) {
      this.preferredInteraction = "input";
    } else if (
      (this.preferredInteraction === "approval" && this.approvals === 0)
      || (this.preferredInteraction === "input" && this.inputs === 0)
    ) {
      this.preferredInteraction = this.approvals > 0
        ? "approval"
        : this.inputs > 0
          ? "input"
          : null;
    }
    return this.refresh(providerState);
  }

  observeDescendant(
    identity: string,
    live: boolean,
    providerState?: string | null,
  ): boolean {
    if (!this.acceptsProviderEvents() || !identity) return false;
    if (live) this.liveDescendants.add(identity);
    else this.liveDescendants.delete(identity);
    return this.refresh(providerState);
  }

  requestCancellation(
    outcome: AgentRunTerminalState | null,
    providerState?: string | null,
  ): boolean {
    if (this.terminal !== null) return false;
    const before = this.current;
    this.cancellationObserved = true;
    this.requestedTerminal ??= outcome;
    this.quarantined = true;
    return this.refresh(providerState) || before.state !== this.current.state;
  }

  requestTerminal(
    outcome: AgentRunTerminalState,
    providerState?: string | null,
  ): boolean {
    return this.requestCancellation(outcome, providerState);
  }

  quarantine(providerState?: string | null): boolean {
    if (this.terminal !== null) return false;
    this.quarantined = true;
    this.cancellationObserved = true;
    return this.refresh(providerState);
  }

  settle(
    outcome: AgentRunTerminalState,
    providerState?: string | null,
  ): AgentRunTerminalState | null {
    if (this.terminal !== null) return null;
    this.terminal = this.requestedTerminal ?? outcome;
    this.requestedTerminal = this.terminal;
    this.refresh(providerState);
    return this.terminal;
  }

  /** A terminal write that cannot be committed is itself an authoritative failure. */
  repairSettlementFailure(providerState: string): boolean {
    if (this.terminal === null) return false;
    this.terminal = "failed";
    this.requestedTerminal = "failed";
    return this.refresh(providerState);
  }

  private derivedState(): AgentRunState {
    if (this.terminal) return this.terminal;
    if (this.cancellationObserved || this.requestedTerminal) return "cancelling";
    if (this.preferredInteraction === "approval" && this.approvals > 0) {
      return "waiting-for-approval";
    }
    if (this.preferredInteraction === "input" && this.inputs > 0) {
      return "waiting-for-input";
    }
    if (this.approvals > 0) return "waiting-for-approval";
    if (this.inputs > 0) return "waiting-for-input";
    if (this.transport === "retrying") return "retrying";
    if (this.liveDescendants.size > 0) return "delegated";
    return this.transport;
  }

  private refresh(providerState?: string | null): boolean {
    const state = this.derivedState();
    const native = providerState === undefined
      ? this.current.providerState
      : boundedProviderState(providerState);
    if (state === this.current.state && native === this.current.providerState) {
      return false;
    }
    this.current = {
      state,
      providerState: native,
      revision: this.current.revision + 1,
    };
    return true;
  }
}
