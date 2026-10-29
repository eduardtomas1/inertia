import type { ProviderEvent, ProviderRunResult } from "../../provider/contracts";

export interface TurnSecretOutputFilter {
  events(event: ProviderEvent): readonly ProviderEvent[];
  result(result: ProviderRunResult): { events: readonly ProviderEvent[]; result: ProviderRunResult };
  closeText(turnId: string): readonly ProviderEvent[];
  discard(turnId: string): void;
}

export interface SecretRequestOpening {
  notBefore: string | null;
}

export interface TurnSecretRequestWaits {
  open(conversationId: string, turnId: string): SecretRequestOpening | null;
  wait(conversationId: string, turnId: string, requestId: string, title: string | null): boolean;
}

export interface SecretRequestTurn {
  turn: { id: string };
  runState: { isTerminal(): boolean; acceptsProviderEvents(): boolean };
}

export interface TurnSecretRequestsOptions<ActiveTurn extends SecretRequestTurn> {
  filter(): TurnSecretOutputFilter | undefined;
  active(conversationId: string): ActiveTurn | undefined;
  project(active: ActiveTurn, event: ProviderEvent): void;
  interactions: {
    secretWait(active: ActiveTurn | undefined, turnId: string, requestId: string, title: string | null): boolean;
    closeForSecretRequest(active: ActiveTurn): string | null;
  };
}

export class TurnSecretRequests<ActiveTurn extends SecretRequestTurn> implements TurnSecretRequestWaits {
  constructor(private readonly options: TurnSecretRequestsOptions<ActiveTurn>) {}

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

  discard(active: ActiveTurn): void {
    this.options.filter()?.discard(active.turn.id);
  }

  open(conversationId: string, turnId: string): SecretRequestOpening | null {
    const active = this.options.active(conversationId);
    if (!active || active.turn.id !== turnId || !active.runState.acceptsProviderEvents()) return null;
    for (const event of this.options.filter()?.closeText(turnId) ?? []) this.options.project(active, event);
    return { notBefore: this.options.interactions.closeForSecretRequest(active) };
  }

  wait(conversationId: string, turnId: string, requestId: string, title: string | null): boolean {
    return this.options.interactions.secretWait(this.options.active(conversationId), turnId, requestId, title);
  }
}
