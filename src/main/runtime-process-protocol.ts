import { isAbsolute } from "node:path";

export interface RuntimeWorkerOptions {
  dataDirectory: string;
  defaultWorkspacePath: string;
  enableProviders: boolean;
}

export type RuntimeWorkerCommand =
  | { type: "runtime.start"; options: RuntimeWorkerOptions }
  | { type: "runtime.shutdown" };

export type RuntimeWorkerEvent =
  | { type: "runtime.ready"; websocketUrl: string }
  | { type: "runtime.startup-failed"; message: string }
  | { type: "runtime.stopped" };

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runtimePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0") && isAbsolute(value);
}

export function parseRuntimeWorkerCommand(value: unknown): RuntimeWorkerCommand | null {
  if (!plainObject(value) || typeof value.type !== "string") return null;
  if (value.type === "runtime.shutdown" && Object.keys(value).length === 1) return { type: "runtime.shutdown" };
  if (value.type !== "runtime.start" || Object.keys(value).length !== 2 || !plainObject(value.options)) return null;
  const options = value.options;
  if (
    Object.keys(options).length !== 3
    || !runtimePath(options.dataDirectory)
    || !runtimePath(options.defaultWorkspacePath)
    || typeof options.enableProviders !== "boolean"
  ) return null;
  return {
    type: "runtime.start",
    options: {
      dataDirectory: options.dataDirectory,
      defaultWorkspacePath: options.defaultWorkspacePath,
      enableProviders: options.enableProviders,
    },
  };
}

export function parseRuntimeWorkerEvent(value: unknown): RuntimeWorkerEvent | null {
  if (!plainObject(value) || typeof value.type !== "string") return null;
  if (value.type === "runtime.stopped" && Object.keys(value).length === 1) return { type: "runtime.stopped" };
  if (value.type === "runtime.startup-failed" && Object.keys(value).length === 2 && typeof value.message === "string") {
    const message = value.message.trim();
    return message && message.length <= 1000 ? { type: "runtime.startup-failed", message } : null;
  }
  if (value.type === "runtime.ready" && Object.keys(value).length === 2 && isRuntimeWebSocketUrl(value.websocketUrl)) {
    return { type: "runtime.ready", websocketUrl: value.websocketUrl };
  }
  return null;
}

export function isRuntimeWebSocketUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return url.protocol === "ws:"
      && url.hostname === "127.0.0.1"
      && Number.isInteger(port)
      && port >= 1
      && port <= 65_535
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && /^\/runtime\/[A-Za-z0-9_-]{43}$/u.test(url.pathname);
  } catch {
    return false;
  }
}
