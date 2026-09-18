import { useEffect, useState } from "react";

import {
  EMPTY_STREAMING_AGENT_STATE,
  type StreamingAgentState,
} from "../utils/terminalTurnProjection";

export interface StreamingAgentSource {
  getSnapshot: () => StreamingAgentState;
  subscribe: (listener: () => void) => () => void;
}

export interface StreamingAgentStore extends StreamingAgentSource {
  update: (
    next:
      | StreamingAgentState
      | ((current: StreamingAgentState) => StreamingAgentState),
  ) => void;
}

export const EMPTY_STREAMING_AGENT_SOURCE: StreamingAgentSource = {
  getSnapshot: () => EMPTY_STREAMING_AGENT_STATE,
  subscribe: () => () => undefined,
};

function sameStreamingAgentState(
  left: StreamingAgentState,
  right: StreamingAgentState,
): boolean {
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
}

export function createStreamingAgentStore(): StreamingAgentStore {
  let state = EMPTY_STREAMING_AGENT_STATE;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update: (next) => {
      const resolved = typeof next === "function" ? next(state) : next;
      if (sameStreamingAgentState(state, resolved)) return;
      state = resolved;
      for (const listener of listeners) listener();
    },
  };
}

interface StreamingAgentObservation<Selection> {
  source: StreamingAgentSource;
  state: StreamingAgentState;
  value: Selection;
}

export function useStreamingAgentSelection<Selection>(
  source: StreamingAgentSource,
  select: (state: StreamingAgentState) => Selection,
  same: (left: Selection, right: Selection) => boolean,
): Selection {
  const [observed, setObserved] = useState<
    StreamingAgentObservation<Selection>
  >(() => {
    const state = source.getSnapshot();
    return { source, state, value: select(state) };
  });
  useEffect(() => {
    let state = source.getSnapshot();
    let value = select(state);
    setObserved((previous) => previous.source === source
      && (previous.state === state || same(previous.value, value))
      ? previous
      : { source, state, value });
    return source.subscribe(() => {
      const nextState = source.getSnapshot();
      if (nextState === state) return;
      state = nextState;
      const nextValue = select(nextState);
      if (same(value, nextValue)) return;
      value = nextValue;
      setObserved({ source, state: nextState, value: nextValue });
    });
  }, [same, select, source]);
  return observed.source === source
    ? observed.value
    : select(source.getSnapshot());
}

function selectStreamingAgentState(
  state: StreamingAgentState,
): StreamingAgentState {
  return state;
}

export function useStreamingAgentState(
  source: StreamingAgentSource,
): StreamingAgentState {
  return useStreamingAgentSelection(
    source,
    selectStreamingAgentState,
    Object.is,
  );
}
