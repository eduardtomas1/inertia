export interface FinalAnswerCompletionSignal {
  turnId: string;
  runId: string;
  isActive: boolean;
}

export interface FinalAnswerObservation {
  conversationId: string;
  turnId: string | null;
  runId: string | null;
  wasActive: boolean;
  answerId: string | null;
}

export interface FinalAnswerObservationTransition {
  observation: FinalAnswerObservation;
  shouldAnchor: boolean;
}

export function initialFinalAnswerObservation(
  conversationId: string,
  signal: FinalAnswerCompletionSignal | null,
  answerId: string | null,
): FinalAnswerObservation {
  return {
    conversationId,
    turnId: signal?.turnId ?? null,
    runId: signal?.runId ?? null,
    wasActive: signal?.isActive ?? false,
    answerId: signal?.isActive ? null : answerId,
  };
}

export function advanceFinalAnswerObservation({
  observed,
  conversationId,
  signal,
  detailLoading,
  answerId,
}: {
  observed: FinalAnswerObservation;
  conversationId: string;
  signal: FinalAnswerCompletionSignal | null;
  detailLoading: boolean;
  answerId: string | null;
}): FinalAnswerObservationTransition {
  if (!signal) {
    return {
      observation: observed.conversationId === conversationId
        ? observed
        : initialFinalAnswerObservation(conversationId, null, null),
      shouldAnchor: false,
    };
  }

  const sameIdentity = observed.conversationId === conversationId
    && observed.turnId === signal.turnId
    && observed.runId === signal.runId;
  if (!sameIdentity) {
    return {
      observation: initialFinalAnswerObservation(
        conversationId,
        signal,
        answerId,
      ),
      shouldAnchor: false,
    };
  }

  if (signal.isActive) {
    return {
      observation: { ...observed, wasActive: true },
      shouldAnchor: false,
    };
  }

  if (detailLoading || answerId === null) {
    return { observation: observed, shouldAnchor: false };
  }

  return {
    observation: {
      ...observed,
      wasActive: false,
      answerId,
    },
    shouldAnchor: observed.wasActive && observed.answerId !== answerId,
  };
}
