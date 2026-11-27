import type { ProviderEvent, ProviderRunFailure, ProviderRunResult } from "../../provider/contracts";

export type TurnSecretEndReason = "timed_out" | "cancelled" | "stopped";

export interface TurnSecretOutputFilter {
  text(value: string): string;
  payload?<T>(value: T, structural?: boolean): T;
  events(event: ProviderEvent): readonly ProviderEvent[];
  result(result: ProviderRunResult): { events: readonly ProviderEvent[]; result: ProviderRunResult };
  closeText(turnId: string): readonly ProviderEvent[];
  discard(turnId: string): void;
}

export interface SecretRequestOpening {
  notBefore: string | null;
}

export interface TurnSecretRequestServiceHooks {
  cancelForTurn(conversationId: string, turnId: string, reason?: TurnSecretEndReason): void;
  hasPending?(conversationId: string): boolean;
}

export interface TurnSecretRequestWaits {
  open(conversationId: string, turnId: string): SecretRequestOpening | null;
  wait(
    conversationId: string,
    turnId: string,
    requestId: string,
    title: string | null,
    cardCreatedAt?: string,
  ): boolean;
  attachService?(service: TurnSecretRequestServiceHooks): void;
}

export interface SecretRequestTurn {
  conversation: { id: string };
  turn: { id: string; status?: string };
  runState: { isTerminal(): boolean; acceptsProviderEvents(): boolean };
}

export interface TurnSecretRequestsOptions<ActiveTurn extends SecretRequestTurn> {
  filter(): TurnSecretOutputFilter | undefined;
  active(conversationId: string): ActiveTurn | undefined;
  project(active: ActiveTurn, event: ProviderEvent): void;
  interactions: {
    secretWait(
      active: ActiveTurn | undefined,
      turnId: string,
      requestId: string,
      title: string | null,
      cardCreatedAt?: string,
    ): boolean;
    clearSecretWaits(active: ActiveTurn): void;
    hasSecretWait(active: ActiveTurn | undefined): boolean;
    closeForSecretRequest(active: ActiveTurn): string | null;
  };
}

export class TurnSecretRequests<ActiveTurn extends SecretRequestTurn> implements TurnSecretRequestWaits {
  private service: TurnSecretRequestServiceHooks | null = null;

  constructor(private readonly options: TurnSecretRequestsOptions<ActiveTurn>) {}

  attachService(service: TurnSecretRequestServiceHooks): void {
    this.service = service;
  }

  text(value: string): string {
    const filter = this.options.filter();
    return filter ? filter.text(value) : value;
  }

  failure(failure: ProviderRunFailure): ProviderRunFailure {
    const filter = this.options.filter();
    if (!filter) return failure;
    return {
      ...failure,
      message: filter.text(failure.message),
      ...(failure.technicalDetail !== undefined
        ? { technicalDetail: filter.text(failure.technicalDetail) }
        : {}),
    };
  }

  events(event: ProviderEvent): readonly ProviderEvent[] {
    const filter = this.options.filter();
    return filter ? filter.events(event) : [event];
  }

  result(active: ActiveTurn, result: ProviderRunResult): ProviderRunResult {
    const filter = this.options.filter();
    if (!filter) return result;
    const output = filter.result(result);
    for (const event of output.events) {
      if (!active.runState.isTerminal()) this.options.project(active, event);
    }
    return output.result;
  }

  cancelForTurn(active: ActiveTurn, reason: TurnSecretEndReason = "stopped"): void {
    this.options.interactions.clearSecretWaits(active);
    this.service?.cancelForTurn(active.conversation.id, active.turn.id, reason);
  }

  hasPending(conversationId: string): boolean {
    return Boolean(
      this.service?.hasPending?.(conversationId)
      || this.options.interactions.hasSecretWait(this.options.active(conversationId)),
    );
  }

  discard(active: ActiveTurn): void {
    this.options.filter()?.discard(active.turn.id);
    this.cancelForTurn(active, active.turn.status === "cancelled" ? "cancelled" : "stopped");
  }

  open(conversationId: string, turnId: string): SecretRequestOpening | null {
    const active = this.options.active(conversationId);
    if (!active || active.turn.id !== turnId || !active.runState.acceptsProviderEvents()) return null;
    for (const event of this.options.filter()?.closeText(turnId) ?? []) this.options.project(active, event);
    return { notBefore: this.options.interactions.closeForSecretRequest(active) };
  }

  wait(
    conversationId: string,
    turnId: string,
    requestId: string,
    title: string | null,
    cardCreatedAt?: string,
  ): boolean {
    return this.options.interactions.secretWait(
      this.options.active(conversationId),
      turnId,
      requestId,
      title,
      cardCreatedAt,
    );
  }
}
