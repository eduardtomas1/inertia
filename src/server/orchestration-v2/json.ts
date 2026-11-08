import { createHash } from "node:crypto";

import type { JsonValue } from "./types";

export const MAX_DURABLE_JSON_BYTES = 1_048_576;

/** Deterministic fingerprints ignore object property insertion order, never array order. */
export function durableJson(value: JsonValue, maxBytes = MAX_DURABLE_JSON_BYTES): string {
  const ancestors = new Set<object>();
  const visit = (item: JsonValue, depth: number): JsonValue => {
    if (depth > 64) throw new Error("Orchestration JSON is too deeply nested.");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error("Orchestration numbers must be finite.");
      return item;
    }
    if (typeof item !== "object" || ancestors.has(item)) {
      throw new Error("Orchestration data must be acyclic JSON.");
    }
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1));
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        throw new Error("Orchestration data must contain only plain JSON objects.");
      }
      const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
      for (const key of Object.keys(item).sort()) {
        result[key] = visit((item as Record<string, JsonValue>)[key]!, depth + 1);
      }
      return result;
    } finally {
      ancestors.delete(item);
    }
  };
  const serialized = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new Error("Orchestration data exceeds its durable size limit.");
  }
  return serialized;
}

export function commandFingerprint(command: JsonValue): string {
  return createHash("sha256").update(durableJson(command)).digest("hex");
}

export function durableId(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 240 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Invalid orchestration identity.");
  }
  return value;
}

export function durableTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error("Orchestration timestamps must be canonical UTC timestamps.");
  }
  return value;
}
