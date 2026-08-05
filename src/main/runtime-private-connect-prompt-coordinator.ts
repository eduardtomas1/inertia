import { randomUUID } from "node:crypto";

import type {
  RuntimePrivateConnectPromptPreparation,
  RuntimeWorkerCommand,
  RuntimeWorkerEvent,
} from "../node/runtime-process-protocol";
import type {
  PrivateConnectRuntimeAuthorization,
  PrivateConnectRuntimeRequest,
  PrivateConnectRuntimeResponse,
} from "../shared/private-connect/runtime-contract";

type Timer = ReturnType<typeof setTimeout>;
type PrivateConnectPromptRequest = Extract<PrivateConnectRuntimeRequest, { type: "prompt.send" }>;
type PrivateConnectPromptResult = RuntimePrivateConnectPromptPreparation | PrivateConnectRuntimeResponse;
type PrivateConnectPromptCommand = Extract<
  RuntimeWorkerCommand,
  {
    type:
      | "runtime.private-connect-prompt-prepare"
      | "runtime.private-connect-prompt-commit";
  }
>;
type PrivateConnectPromptEvent = Extract<
  RuntimeWorkerEvent,
  { type: "runtime.private-connect-prompt-result" }
>;

interface PendingPrivateConnectPrompt<RecordType> {
  record: RecordType;
  requestId: string;
  phase: "prepare" | "commit";
  timer: Timer;
  resolve(result: PrivateConnectPromptResult): void;
  reject(error: Error): void;
}

export class RuntimePrivateConnectPromptCoordinator<RecordType> {
  private readonly pending =
    new Map<string, PendingPrivateConnectPrompt<RecordType>>();

  constructor(private readonly options: {
    timeoutMs: number;
    setTimer: typeof setTimeout;
    clearTimer: typeof clearTimeout;
    post(record: RecordType, command: PrivateConnectPromptCommand): boolean;
  }) {}

  prepare(
    record: RecordType,
    subject: PrivateConnectRuntimeAuthorization,
    request: PrivateConnectPromptRequest,
  ): Promise<PrivateConnectPromptResult> {
    return this.begin(record, "prepare", subject, request);
  }

  commit(
    record: RecordType,
    subject: PrivateConnectRuntimeAuthorization,
    request: PrivateConnectPromptRequest,
    preparationId: string,
    onPosted?: () => void,
  ): Promise<PrivateConnectRuntimeResponse> {
    return this.begin(
      record,
      "commit",
      subject,
      request,
      preparationId,
      onPosted,
    ).then((result) => {
      if ("preparationId" in result) {
        throw new Error("The Private Connect prompt commit was invalid.");
      }
      return result;
    });
  }

  handle(record: RecordType, event: PrivateConnectPromptEvent): void {
    const pending = this.pending.get(event.operationId);
    if (
      !pending
      || pending.record !== record
      || pending.requestId !== event.requestId
      || pending.phase !== event.phase
    ) return;
    this.pending.delete(event.operationId);
    this.options.clearTimer(pending.timer);
    pending.resolve(
      event.response ?? { preparationId: event.preparationId as string },
    );
  }

  reject(record: RecordType, message: string): void {
    for (const [operationId, pending] of this.pending) {
      if (pending.record !== record) continue;
      this.pending.delete(operationId);
      this.options.clearTimer(pending.timer);
      pending.reject(new Error(message));
    }
  }

  private begin(
    record: RecordType,
    phase: "prepare" | "commit",
    subject: PrivateConnectRuntimeAuthorization,
    request: PrivateConnectPromptRequest,
    preparationId?: string,
    onPosted?: () => void,
  ): Promise<PrivateConnectPromptResult> {
    const operationId = randomUUID();
    return new Promise<PrivateConnectPromptResult>((resolve, reject) => {
      const timer = this.options.setTimer(() => {
        this.pending.delete(operationId);
        reject(new Error(
          phase === "commit"
            ? "Private Connect prompt delivery is uncertain."
            : "Private Connect prompt preparation timed out.",
        ));
      }, this.options.timeoutMs);
      this.pending.set(operationId, {
        record,
        requestId: request.requestId,
        phase,
        timer,
        resolve,
        reject,
      });
      if (phase === "commit" && !preparationId) {
        this.rejectOperation(
          operationId,
          timer,
          reject,
          "The Private Connect prompt preparation was invalid.",
        );
        return;
      }
      const command: PrivateConnectPromptCommand = phase === "prepare"
        ? {
            type: "runtime.private-connect-prompt-prepare",
            operationId,
            subject,
            request,
          }
        : {
            type: "runtime.private-connect-prompt-commit",
            operationId,
            preparationId: preparationId as string,
            subject,
            request,
          };
      if (this.options.post(record, command)) {
        if (phase === "commit") onPosted?.();
        return;
      }
      this.rejectOperation(
        operationId,
        timer,
        reject,
        phase === "commit"
          ? "The Private Connect prompt commit could not be posted."
          : "The Private Connect prompt preparation could not be posted.",
      );
    });
  }

  private rejectOperation(
    operationId: string,
    timer: Timer,
    reject: (error: Error) => void,
    message: string,
  ): void {
    this.pending.delete(operationId);
    this.options.clearTimer(timer);
    reject(new Error(message));
  }
}
