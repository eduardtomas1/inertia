import { randomUUID } from "node:crypto";

import type {
  AgentBrowserCommand,
  AgentBrowserResult,
  AgentBrowserRunIdentity,
} from "../../shared/agent-browser.js";
import type {
  RuntimeWorkerEvent,
} from "../../node/runtime-process-protocol.js";
import type { RuntimeAgentBrowserResult } from "../../node/runtime-agent-browser-protocol.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_PENDING_REQUESTS = 16;

interface PendingRequest {
  identity: AgentBrowserRunIdentity;
  timer: NodeJS.Timeout;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | null;
  resolve: (result: AgentBrowserResult) => void;
}

export interface RuntimeAgentBrowserBroker {
  perform(
    identity: AgentBrowserRunIdentity,
    command: AgentBrowserCommand,
    signal?: AbortSignal,
  ): Promise<AgentBrowserResult>;
}

function unavailable(message: string): AgentBrowserResult {
  return { ok: false, code: "unavailable", message };
}

export class RuntimeAgentBrowserBrokerClient
implements RuntimeAgentBrowserBroker {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly timeoutMs: number;
  private closed = false;

  constructor(
    private readonly post: (event: RuntimeWorkerEvent) => void,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.timeoutMs = Math.max(1, Math.min(Math.trunc(timeoutMs), 30_000));
  }

  perform(
    identity: AgentBrowserRunIdentity,
    command: AgentBrowserCommand,
    signal?: AbortSignal,
  ): Promise<AgentBrowserResult> {
    if (this.closed) {
      return Promise.resolve(unavailable("The Inertia browser service stopped."));
    }
    if (signal?.aborted) {
      return Promise.resolve({
        ok: false,
        code: "cancelled",
        message: "The browser action was cancelled.",
      });
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.resolve(unavailable("Too many browser actions are active."));
    }
    const requestId = randomUUID();
    return new Promise<AgentBrowserResult>((resolve) => {
      const settle = (result: AgentBrowserResult): void => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        this.cleanup(pending);
        resolve(result);
      };
      const timer = setTimeout(() => {
        this.post({
          type: "runtime.agent-browser-cancel",
          requestId,
          identity,
        });
        settle(unavailable("The browser action timed out."));
      }, this.timeoutMs);
      const onAbort = signal
        ? () => {
            this.post({
              type: "runtime.agent-browser-cancel",
              requestId,
              identity,
            });
            settle({
              ok: false,
              code: "cancelled",
              message: "The browser action was cancelled.",
            });
          }
        : null;
      const pending: PendingRequest = {
        identity,
        timer,
        signal,
        onAbort,
        resolve,
      };
      this.pending.set(requestId, pending);
      signal?.addEventListener("abort", onAbort!, { once: true });
      this.post({
        type: "runtime.agent-browser-request",
        requestId,
        identity,
        command,
      });
    });
  }

  handle(result: RuntimeAgentBrowserResult): boolean {
    const pending = this.pending.get(result.requestId);
    if (!pending) return false;
    this.pending.delete(result.requestId);
    this.cleanup(pending);
    pending.resolve(result.result);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      this.cleanup(pending);
      this.post({
        type: "runtime.agent-browser-cancel",
        requestId,
        identity: pending.identity,
      });
      pending.resolve(unavailable("The Inertia browser service stopped."));
    }
  }

  private cleanup(pending: PendingRequest): void {
    clearTimeout(pending.timer);
    if (pending.onAbort) {
      pending.signal?.removeEventListener("abort", pending.onAbort);
    }
  }
}
