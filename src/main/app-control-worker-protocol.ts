import {
  APP_CONTROL_MAX_PAYLOAD_BYTES,
  APP_CONTROL_RESULT_KIND,
  appControlPayloadBytes,
  parseAppControlResult,
  type AppControlCommand,
  type AppControlResult,
} from "../node/runtime-app-control-protocol.js";
import type { AppControlProcessEntry } from "./app-control-process-tree.js";

/** Messages between main's App control service and its utility worker. */

/** A masked worker capture before main reduces it to a thumbnail. */
export const APP_CONTROL_CAPTURE_MAX_BYTES = 8 * 1024 * 1024;

export type AppControlWorkerCommand =
  | Exclude<AppControlCommand, { command: "permissions" }>
  | { command: "tree"; rootPid: number };

export interface AppControlWorkerRequest {
  id: number;
  scope: { pids: number[]; deniedPids: number[] };
  command: AppControlWorkerCommand;
  /** macOS screenshots only: the folder main created for this worker's captures. */
  captureDirectory?: string;
}

export type AppControlWorkerResult =
  | AppControlResult
  | { ok: true; value: { kind: "tree"; entries: AppControlProcessEntry[] } };

export interface AppControlWorkerResponse {
  id: number;
  result: AppControlWorkerResult;
}

const MAX_TREE_ENTRIES = 65_536;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTreeEntry(value: unknown): AppControlProcessEntry | null {
  if (!plainObject(value) || Object.keys(value).length !== 4) return null;
  const { pid, parentPid, startedAtMs, executable } = value;
  const safe = (candidate: unknown): candidate is number => typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0;
  if (!safe(pid) || !safe(parentPid) || !(startedAtMs === null || safe(startedAtMs))
    || !(executable === null || (typeof executable === "string" && executable.length <= 1_024))) return null;
  return { pid, parentPid, startedAtMs: startedAtMs as number | null, executable: executable as string | null };
}

/**
 * Validates a worker response for the command it answers. A screenshot may
 * carry an image of up to 8 MiB (main reduces it to a thumbnail); every other
 * value must fit the 24 KiB payload bound.
 */
export function parseAppControlWorkerResponse(
  value: unknown,
  id: number,
  command: AppControlWorkerCommand["command"],
): AppControlWorkerResult | null {
  if (!plainObject(value) || value.id !== id || Object.keys(value).length !== 2 || !plainObject(value.result)) return null;
  const result = value.result;
  if (command === "tree") {
    const tree = plainObject(result.value) ? result.value : null;
    if (result.ok !== true || !tree || tree.kind !== "tree" || !Array.isArray(tree.entries)
      || tree.entries.length > MAX_TREE_ENTRIES) return result.ok === false ? parseAppControlResult(result) : null;
    const entries = tree.entries.map(parseTreeEntry);
    return entries.every((entry) => entry !== null) ? { ok: true, value: { kind: "tree", entries: entries as AppControlProcessEntry[] } } : null;
  }
  if (command === "screenshot" && result.ok === true && plainObject(result.value) && result.value.kind === "screenshot") {
    const shot = result.value;
    if (!(shot.png instanceof Uint8Array) || shot.png.byteLength > APP_CONTROL_CAPTURE_MAX_BYTES || shot.png.byteLength < 24
      || !PNG_SIGNATURE.every((byte, index) => (shot.png as Uint8Array)[index] === byte)
      || appControlPayloadBytes(result) > APP_CONTROL_MAX_PAYLOAD_BYTES) return null;
    const keys = Object.keys(shot).sort().join(",");
    if (keys !== "height,kind,mayIncludeOverlappingWindows,png,width" || typeof shot.mayIncludeOverlappingWindows !== "boolean"
      || !Number.isSafeInteger(shot.width) || !Number.isSafeInteger(shot.height)
      || (shot.width as number) <= 0 || (shot.height as number) <= 0) return null;
    return {
      ok: true,
      value: {
        kind: "screenshot",
        png: new Uint8Array(shot.png),
        width: shot.width as number,
        height: shot.height as number,
        mayIncludeOverlappingWindows: shot.mayIncludeOverlappingWindows,
      },
    };
  }
  const parsed = parseAppControlResult(result);
  if (!parsed || (parsed.ok && parsed.value.kind !== APP_CONTROL_RESULT_KIND[command])) return null;
  return parsed;
}
