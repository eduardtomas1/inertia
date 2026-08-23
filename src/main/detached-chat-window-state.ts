import type { Rectangle } from "electron";

import {
  readSecureAtomicState,
  writeSecureAtomicState,
} from "./secure-atomic-state.js";
import { restoreReachableWindowBounds } from "./window-bounds.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const STATE_VERSION = 1;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_SAVED_WINDOWS = 64;
export const DETACHED_CHAT_DEFAULT_BOUNDS = Object.freeze({
  width: 640,
  height: 780,
});

export const DETACHED_CHAT_MIN_BOUNDS = Object.freeze({
  width: 440,
  height: 520,
});

export const DETACHED_CHAT_MAX_BOUNDS = Object.freeze({
  width: 3_200,
  height: 2_400,
});

export interface DetachedChatWindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface DetachedChatDisplay {
  workArea: Rectangle;
}

export interface DetachedChatWindowStateEntry {
  conversationId: string;
  bounds: Rectangle;
}

export interface DetachedChatWindowStateSnapshot {
  version: 1;
  windows: DetachedChatWindowStateEntry[];
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function parseEntry(value: unknown): DetachedChatWindowStateEntry | null {
  if (!plainObject(value) || Object.keys(value).length !== 2) return null;
  if (
    typeof value.conversationId !== "string"
    || !UUID_PATTERN.test(value.conversationId)
    || !plainObject(value.bounds)
  ) return null;
  const bounds = value.bounds;
  if (
    Object.keys(bounds).length !== 4
    || !integer(bounds.x)
    || !integer(bounds.y)
    || !integer(bounds.width)
    || !integer(bounds.height)
    || bounds.width < 1
    || bounds.width > 10_000
    || bounds.height < 1
    || bounds.height > 10_000
    || Math.abs(bounds.x) > 100_000
    || Math.abs(bounds.y) > 100_000
  ) return null;
  return {
    conversationId: value.conversationId,
    bounds: {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    },
  };
}

/**
 * Parses only cosmetic native-window state. Invalid entries are discarded
 * independently so one corrupt chat cannot erase otherwise usable bounds.
 */
export function parseDetachedChatWindowState(
  value: unknown,
): DetachedChatWindowStateSnapshot {
  if (
    !plainObject(value)
    || Object.keys(value).length !== 2
    || value.version !== STATE_VERSION
    || !Array.isArray(value.windows)
    || value.windows.length > MAX_SAVED_WINDOWS
  ) return { version: STATE_VERSION, windows: [] };

  const byConversation = new Map<string, DetachedChatWindowStateEntry>();
  for (const candidate of value.windows) {
    const entry = parseEntry(candidate);
    if (!entry) continue;
    // The final occurrence is authoritative and becomes most recently used.
    byConversation.delete(entry.conversationId);
    byConversation.set(entry.conversationId, entry);
  }
  return {
    version: STATE_VERSION,
    windows: [...byConversation.values()],
  };
}

export function restoreDetachedChatWindowBounds(
  saved: Rectangle | null,
  displays: readonly DetachedChatDisplay[],
): DetachedChatWindowBounds {
  if (!saved) return { ...DETACHED_CHAT_DEFAULT_BOUNDS };
  return restoreReachableWindowBounds(saved, displays, {
    minimum: DETACHED_CHAT_MIN_BOUNDS,
    maximum: DETACHED_CHAT_MAX_BOUNDS,
  });
}

export class DetachedChatWindowStateStore {
  readonly #entries = new Map<string, Rectangle>();

  constructor(readonly path: string) {
    const snapshot = this.#read();
    for (const entry of snapshot.windows) {
      this.#entries.set(entry.conversationId, entry.bounds);
    }
  }

  restore(
    conversationId: string,
    displays: readonly DetachedChatDisplay[],
  ): DetachedChatWindowBounds {
    const saved = this.#entries.get(conversationId) ?? null;
    if (saved) {
      this.#entries.delete(conversationId);
      this.#entries.set(conversationId, saved);
    }
    return restoreDetachedChatWindowBounds(saved, displays);
  }

  remember(conversationId: string, bounds: Rectangle): void {
    const entry = parseEntry({ conversationId, bounds });
    if (!entry) return;
    this.#entries.delete(conversationId);
    this.#entries.set(conversationId, entry.bounds);
    while (this.#entries.size > MAX_SAVED_WINDOWS) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#entries.delete(oldest);
    }
  }

  flush(): void {
    try {
      const snapshot: DetachedChatWindowStateSnapshot = {
        version: STATE_VERSION,
        windows: [...this.#entries].map(([conversationId, bounds]) => ({
          conversationId,
          bounds,
        })),
      };
      writeSecureAtomicState(
        this.path,
        JSON.stringify(snapshot),
        MAX_STATE_BYTES,
      );
    } catch {
      // Window bounds are cosmetic and must never block close or shutdown.
    }
  }

  snapshot(): DetachedChatWindowStateSnapshot {
    return {
      version: STATE_VERSION,
      windows: [...this.#entries].map(([conversationId, bounds]) => ({
        conversationId,
        bounds: { ...bounds },
      })),
    };
  }

  #read(): DetachedChatWindowStateSnapshot {
    try {
      const content = readSecureAtomicState(this.path, MAX_STATE_BYTES);
      if (content === null) return { version: STATE_VERSION, windows: [] };
      return parseDetachedChatWindowState(
        JSON.parse(content),
      );
    } catch {
      return { version: STATE_VERSION, windows: [] };
    }
  }
}
