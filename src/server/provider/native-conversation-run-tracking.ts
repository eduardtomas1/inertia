import type { AgentHarnessRun, AgentHarnessStartOptions } from "./agent-harness";

const references = new WeakMap<Set<string>, Map<string, number>>();

/** Track native session announcements as well as requested resumes. */
export function trackNativeConversationRun(
  active: Set<string>,
  options: AgentHarnessStartOptions,
  start: (options: AgentHarnessStartOptions) => AgentHarnessRun,
): AgentHarnessRun {
  const ids = new Set<string>();
  const counts = references.get(active) ?? new Map<string, number>();
  references.set(active, counts);
  const record = (id: string): void => {
    if (ids.has(id)) return;
    ids.add(id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
    active.add(id);
  };
  const release = (): void => {
    for (const id of ids) {
      const remaining = (counts.get(id) ?? 1) - 1;
      if (remaining > 0) counts.set(id, remaining);
      else { counts.delete(id); active.delete(id); }
    }
    ids.clear();
  };
  if (options.input.sessionId) record(options.input.sessionId);
  if (options.nativeContinuation) record(options.nativeContinuation.nativeConversationId);
  let run: AgentHarnessRun;
  try {
    run = start({ ...options, callbacks: { onEvent: (event) => {
      if (event.type === "session") record(event.sessionId);
      options.callbacks?.onEvent?.(event);
    } } });
  } catch (error) {
    release();
    throw error;
  }
  void run.result.then((result) => {
    if (result.sessionId) record(result.sessionId);
    if (result.cleanupConfirmed) release();
    else if (result.cleanupConfirmation) {
      void result.cleanupConfirmation.then((confirmed) => { if (confirmed) release(); }, () => undefined);
    }
  }, () => undefined);
  return run;
}
