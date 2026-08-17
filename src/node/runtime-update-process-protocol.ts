export type RuntimeUpdatePreparationBlocker =
  | "agent-work"
  | "terminal"
  | "provider-maintenance"
  | "provider-refresh"
  | "database-recovery"
  | "runtime-operation";

export type RuntimeUpdatePreparationResult =
  | { ready: true }
  | { ready: false; blocker: RuntimeUpdatePreparationBlocker };

export type RuntimeUpdateWorkerCommand =
  | {
      type: "runtime.prepare-update";
      operationId: string;
      generation: number;
    }
  | {
      type: "runtime.release-update-preparation";
      operationId: string;
      generation: number;
    };

export type RuntimeUpdateWorkerEvent =
  | ({
      type: "runtime.prepare-update-result";
      operationId: string;
      generation: number;
    } & RuntimeUpdatePreparationResult)
  | {
      type: "runtime.release-update-preparation-result";
      operationId: string;
      generation: number;
      released: boolean;
    };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function identity(value: Record<string, unknown>): value is Record<string, unknown> & {
  operationId: string;
  generation: number;
} {
  return typeof value.operationId === "string"
    && UUID_PATTERN.test(value.operationId)
    && typeof value.generation === "number"
    && Number.isSafeInteger(value.generation)
    && value.generation > 0;
}

export function parseRuntimeUpdateWorkerCommand(
  value: Record<string, unknown>,
): RuntimeUpdateWorkerCommand | null {
  if (
    (
      value.type !== "runtime.prepare-update"
      && value.type !== "runtime.release-update-preparation"
    )
    || Object.keys(value).length !== 3
    || !identity(value)
  ) return null;
  return {
    type: value.type,
    operationId: value.operationId,
    generation: value.generation,
  };
}

export function parseRuntimeUpdateWorkerEvent(
  value: Record<string, unknown>,
): RuntimeUpdateWorkerEvent | null {
  if (!identity(value)) return null;
  if (
    value.type === "runtime.release-update-preparation-result"
    && Object.keys(value).length === 4
    && typeof value.released === "boolean"
  ) return {
    type: value.type,
    operationId: value.operationId,
    generation: value.generation,
    released: value.released,
  };
  if (
    value.type !== "runtime.prepare-update-result"
    || typeof value.ready !== "boolean"
  ) return null;
  if (value.ready && Object.keys(value).length === 4) return {
    type: value.type,
    operationId: value.operationId,
    generation: value.generation,
    ready: true,
  };
  if (
    !value.ready
    && Object.keys(value).length === 5
    && (
      value.blocker === "agent-work"
      || value.blocker === "terminal"
      || value.blocker === "provider-maintenance"
      || value.blocker === "provider-refresh"
      || value.blocker === "database-recovery"
      || value.blocker === "runtime-operation"
    )
  ) return {
    type: value.type,
    operationId: value.operationId,
    generation: value.generation,
    ready: false,
    blocker: value.blocker,
  };
  return null;
}
