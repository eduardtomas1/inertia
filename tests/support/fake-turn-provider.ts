import type { AgentApprovalDecision } from "../../src/shared/contracts";
import {
  providerRunTerminal,
  type ProviderEvent,
  type ProviderRunCallbacks,
  type ProviderRunInput,
  type ProviderRunResult,
} from "../../src/server/provider/contracts";
import type {
  TurnProviderRuntime,
  TurnTimerScheduler,
} from "../../src/server/runtime/turns/turn-controller";
import { resolveNativeModelRoute } from "../server/model-route-fixture";

export class FakeTurnScheduler implements TurnTimerScheduler {
  private nextId = 0;
  readonly callbacks = new Map<number, () => void>();
  readonly delays = new Map<number, number>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.callbacks.set(id, callback);
    this.delays.set(id, delayMs);
    return id;
  }

  clearTimeout(handle: unknown): void {
    const id = handle as number;
    this.callbacks.delete(id);
    this.delays.delete(id);
  }

  runAll(): void {
    const pending = [...this.callbacks].sort(([left], [right]) =>
      (this.delays.get(left) ?? 0) - (this.delays.get(right) ?? 0));
    for (const [id, callback] of pending) {
      if (!this.callbacks.has(id)) continue;
      this.callbacks.delete(id);
      this.delays.delete(id);
      callback();
    }
  }
}

export class FakeTurnProvider implements TurnProviderRuntime {
  providerCapabilityAvailable(): boolean {
    return true;
  }
  callbacks: ProviderRunCallbacks | null = null;
  input: ProviderRunInput | null = null;
  cancelCount = 0;
  disposed = false;
  approvalSupported = true;
  inputSupported = true;
  steerSupported = true;
  stopSubagentSupported = true;
  readonly steerCalls: string[] = [];
  readonly stoppedSubagentIds: string[] = [];
  readonly stopOwnedCalls: Array<{
    conversationId: string;
    identity: { runId: string; turnId: string };
  }> = [];
  runCount = 0;
  private runningConversationId: string | null = null;
  private stopOwnedGate: Promise<"force-detached"> | null = null;
  private resolveStopOwnedGate: (() => void) | null = null;
  private resolveResult: ((result: ProviderRunResult) => void) | null = null;
  private rejectResult: ((error: unknown) => void) | null = null;

  resolveModelRoute = resolveNativeModelRoute;

  harnessIdFor(input: ProviderRunInput): string {
    return input.harnessId;
  }

  run(input: ProviderRunInput, callbacks: ProviderRunCallbacks): Promise<ProviderRunResult> {
    this.runCount += 1;
    this.runningConversationId = input.conversationId;
    this.input = input;
    this.callbacks = callbacks;
    callbacks.onStarted?.();
    return new Promise((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
  }

  emit(event: ProviderEvent): void {
    this.callbacks?.onEvent?.(event);
  }

  resolve(result: Partial<ProviderRunResult> = {}): void {
    if (!this.input) throw new Error("Provider has not started.");
    this.runningConversationId = null;
    const status = result.status ?? "completed";
    this.resolveResult?.({
      ...providerRunTerminal(this.input, status, result.failure),
      text: "",
      textTruncated: false,
      exitCode: 0,
      signal: null,
      cleanupConfirmed: true,
      ...result,
    });
  }

  reject(error: unknown): void {
    // A rejected provider promise is not process cleanup proof. Keep the
    // exact owner live until TurnController joins stopOwned() and receives its
    // explicit cleanup result, matching production ProviderManager semantics.
    this.rejectResult?.(error);
  }

  cancel(): boolean {
    this.cancelCount += 1;
    return true;
  }

  stopOwned(
    conversationId: string,
    identity: { runId: string; turnId: string },
  ): Promise<"settled" | "force-detached"> {
    this.stopOwnedCalls.push({ conversationId, identity });
    if (this.stopOwnedGate) return this.stopOwnedGate;
    this.runningConversationId = null;
    return Promise.resolve("settled");
  }

  deferOwnedStop(): void {
    this.stopOwnedGate = new Promise<"force-detached">((resolve) => {
      this.resolveStopOwnedGate = () => resolve("force-detached");
    });
  }

  resolveOwnedStop(): void {
    this.resolveStopOwnedGate?.();
    this.resolveStopOwnedGate = null;
    this.stopOwnedGate = null;
  }

  isRunning(conversationId: string): boolean {
    return this.runningConversationId === conversationId;
  }

  ownsRun(
    conversationId: string,
    identity: { runId: string; turnId: string },
  ): boolean {
    return this.runningConversationId === conversationId
      && this.input?.runId === identity.runId
      && this.input.turnId === identity.turnId;
  }

  respondToApproval(
    _conversationId: string,
    _requestId: string,
    _decision: AgentApprovalDecision,
    _identity: { runId: string; turnId: string },
  ): boolean {
    return this.approvalSupported;
  }

  respondToInput(
    _conversationId: string,
    _requestId: string,
    _answers: Record<string, string[]>,
    _identity: { runId: string; turnId: string },
  ): boolean {
    return this.inputSupported;
  }

  async steer(
    _conversationId: string,
    input: import("../../src/server/provider/contracts").ProviderSteerInput,
  ): Promise<boolean> {
    this.steerCalls.push(input.content);
    return this.steerSupported;
  }

  async stopSubagent(
    _conversationId: string,
    providerTaskId: string,
  ): Promise<boolean> {
    this.stoppedSubagentIds.push(providerTaskId);
    return this.stopSubagentSupported;
  }

  async disposeAll(): Promise<void> {
    this.disposed = true;
  }
}
