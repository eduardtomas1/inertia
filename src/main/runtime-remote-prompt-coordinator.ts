import { randomUUID } from "node:crypto";

import type {
  RuntimeRemotePromptPreparation,
  RuntimeWorkerCommand,
  RuntimeWorkerEvent,
} from "../node/runtime-process-protocol";
import type {
  RemoteAuthorizationSubject,
  RemoteRequest,
  RemoteResponse,
} from "../shared/remote-protocol";

type Timer = ReturnType<typeof setTimeout>;
type RemotePromptRequest = Extract<RemoteRequest, { type: "prompt.send" }>;
type RemotePromptResult = RuntimeRemotePromptPreparation | RemoteResponse;
type RemotePromptCommand = Extract<
  RuntimeWorkerCommand,
  {
    type:
      | "runtime.remote-prompt-prepare"
      | "runtime.remote-prompt-commit";
  }
>;
type RemotePromptEvent = Extract<
  RuntimeWorkerEvent,
  { type: "runtime.remote-prompt-result" }
>;

interface PendingRemotePrompt<RecordType> {
  record: RecordType;
  requestId: string;
  phase: "prepare" | "commit";
  timer: Timer;
  resolve(result: RemotePromptResult): void;
  reject(error: Error): void;
}

export class RuntimeRemotePromptCoordinator<RecordType> {
  private readonly pending =
    new Map<string, PendingRemotePrompt<RecordType>>();

  constructor(private readonly options: {
    timeoutMs: number;
    setTimer: typeof setTimeout;
    clearTimer: typeof clearTimeout;
    post(record: RecordType, command: RemotePromptCommand): boolean;
  }) {}

  prepare(
    record: RecordType,
    subject: RemoteAuthorizationSubject,
    request: RemotePromptRequest,
  ): Promise<RemotePromptResult> {
    return this.begin(record, "prepare", subject, request);
  }

  commit(
    record: RecordType,
    subject: RemoteAuthorizationSubject,
    request: RemotePromptRequest,
    preparationId: string,
    onPosted?: () => void,
  ): Promise<RemoteResponse> {
    return this.begin(
      record,
      "commit",
      subject,
      request,
      preparationId,
      onPosted,
    ).then((result) => {
      if ("preparationId" in result) {
        throw new Error("The remote prompt commit was invalid.");
      }
      return result;
    });
  }

  handle(record: RecordType, event: RemotePromptEvent): void {
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
    subject: RemoteAuthorizationSubject,
    request: RemotePromptRequest,
    preparationId?: string,
    onPosted?: () => void,
  ): Promise<RemotePromptResult> {
    const operationId = randomUUID();
    return new Promise<RemotePromptResult>((resolve, reject) => {
      const timer = this.options.setTimer(() => {
        this.pending.delete(operationId);
        reject(new Error(
          phase === "commit"
            ? "Remote prompt delivery is uncertain."
            : "Remote prompt preparation timed out.",
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
          "The remote prompt preparation was invalid.",
        );
        return;
      }
      const command: RemotePromptCommand = phase === "prepare"
        ? {
            type: "runtime.remote-prompt-prepare",
            operationId,
            subject,
            request,
          }
        : {
            type: "runtime.remote-prompt-commit",
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
          ? "The remote prompt commit could not be posted."
          : "The remote prompt preparation could not be posted.",
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
