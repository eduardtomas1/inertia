import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { ActiveAgentPhase } from "../../utils/response-timeline/active-state";
import { PHASE_ORB_MOTION } from "./orbMotion";

export const LIVE_PHASE_CHANNEL_NAME = "inertia.working-indicator.live-phase.v1";
export const LIVE_PHASE_PROTOCOL = "inertia.live-phase";
export const LIVE_PHASE_HEARTBEAT_MS = 700;
export const LIVE_PHASE_REMOTE_TTL_MS = 2_000;
const MAX_ENTRIES = 256;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/u;

export interface LiveAgentPhase {
  conversationId: string;
  turnId: string;
  phase: ActiveAgentPhase;
  at: number;
}

export interface LivePhaseMessage {
  protocol: typeof LIVE_PHASE_PROTOCOL;
  version: 1;
  kind: "state" | "hello" | "bye";
  windowId: string;
  entries: LiveAgentPhase[];
}

export interface LivePhaseTransport {
  post(message: LivePhaseMessage): void;
  listen(listener: (data: unknown) => void): () => void;
  close(): void;
}

export interface LivePhaseEnvironment {
  now(): number;
  windowId: string;
  transport: LivePhaseTransport | null;
  setTimer(callback: () => void, delayMs: number): number;
  clearTimer(handle: number): void;
  onUnload(listener: () => void): () => void;
}

export interface LivePhaseRegistry {
  publish(token: symbol, entry: Omit<LiveAgentPhase, "at">): void;
  withdraw(token: symbol): void;
  resolve(conversationId: string, turnId: string | null | undefined): ActiveAgentPhase | null;
  subscribe(listener: () => void): () => void;
  receive(data: unknown): void;
  dispose(): void;
}

export function isKnownAgentPhase(value: unknown): value is ActiveAgentPhase {
  return typeof value === "string" && Object.hasOwn(PHASE_ORB_MOTION, value);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

export function parseLivePhaseMessage(data: unknown): LivePhaseMessage | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (
    record.protocol !== LIVE_PHASE_PROTOCOL
    || record.version !== 1
    || (record.kind !== "state" && record.kind !== "hello" && record.kind !== "bye")
    || !validIdentifier(record.windowId)
    || !Array.isArray(record.entries)
    || record.entries.length > MAX_ENTRIES
  ) return null;
  const entries: LiveAgentPhase[] = [];
  for (const candidate of record.entries as unknown[]) {
    if (!candidate || typeof candidate !== "object") continue;
    const entry = candidate as Record<string, unknown>;
    if (
      !validIdentifier(entry.conversationId)
      || !validIdentifier(entry.turnId)
      || !isKnownAgentPhase(entry.phase)
      || typeof entry.at !== "number"
      || !Number.isFinite(entry.at)
    ) continue;
    entries.push({
      conversationId: entry.conversationId,
      turnId: entry.turnId,
      phase: entry.phase,
      at: entry.at,
    });
  }
  return { protocol: LIVE_PHASE_PROTOCOL, version: 1, kind: record.kind, windowId: record.windowId, entries };
}

function newer(left: LiveAgentPhase & { source: string }, right: LiveAgentPhase & { source: string }): boolean {
  return left.at > right.at || (left.at === right.at && left.source > right.source);
}

export function createLivePhaseRegistry(environment: LivePhaseEnvironment): LivePhaseRegistry {
  const local = new Map<symbol, LiveAgentPhase>();
  const remote = new Map<string, { entries: LiveAgentPhase[]; receivedAt: number }>();
  const listeners = new Set<() => void>();
  let heartbeat: number | null = null;
  let expiry: number | null = null;
  let disposed = false;

  const notify = (): void => {
    for (const listener of Array.from(listeners)) listener();
  };

  const post = (kind: LivePhaseMessage["kind"]): void => {
    environment.transport?.post({
      protocol: LIVE_PHASE_PROTOCOL,
      version: 1,
      kind,
      windowId: environment.windowId,
      entries: kind === "state" ? [...local.values()] : [],
    });
  };

  const scheduleHeartbeat = (): void => {
    if (heartbeat !== null || disposed || !environment.transport || local.size === 0) return;
    heartbeat = environment.setTimer(() => {
      heartbeat = null;
      if (local.size === 0) return;
      post("state");
      scheduleHeartbeat();
    }, LIVE_PHASE_HEARTBEAT_MS);
  };

  const prune = (): boolean => {
    const now = environment.now();
    let changed = false;
    for (const [windowId, state] of remote) {
      if (now - state.receivedAt >= LIVE_PHASE_REMOTE_TTL_MS) {
        remote.delete(windowId);
        changed = true;
      }
    }
    return changed;
  };

  const scheduleExpiry = (): void => {
    if (expiry !== null || disposed || remote.size === 0) return;
    const now = environment.now();
    let next = Number.POSITIVE_INFINITY;
    for (const state of remote.values()) next = Math.min(next, state.receivedAt + LIVE_PHASE_REMOTE_TTL_MS);
    expiry = environment.setTimer(() => {
      expiry = null;
      if (prune()) notify();
      scheduleExpiry();
    }, Math.max(0, next - now));
  };

  const localChanged = (): void => {
    post("state");
    scheduleHeartbeat();
    notify();
  };

  const receive = (data: unknown): void => {
    if (disposed) return;
    const message = parseLivePhaseMessage(data);
    if (!message || message.windowId === environment.windowId) return;
    if (message.kind === "hello") {
      if (local.size > 0) post("state");
      return;
    }
    if (message.kind === "bye" || message.entries.length === 0) {
      if (remote.delete(message.windowId)) notify();
      return;
    }
    remote.set(message.windowId, { entries: message.entries, receivedAt: environment.now() });
    scheduleExpiry();
    notify();
  };

  const stopListening = environment.transport?.listen(receive) ?? (() => undefined);
  const stopUnload = environment.onUnload(() => registry.dispose());
  environment.transport?.post({
    protocol: LIVE_PHASE_PROTOCOL,
    version: 1,
    kind: "hello",
    windowId: environment.windowId,
    entries: [],
  });

  const registry: LivePhaseRegistry = {
    publish(token, entry) {
      if (disposed) return;
      const current = local.get(token);
      if (
        current
        && current.conversationId === entry.conversationId
        && current.turnId === entry.turnId
        && current.phase === entry.phase
      ) return;
      local.set(token, { ...entry, at: environment.now() });
      localChanged();
    },
    withdraw(token) {
      if (disposed || !local.delete(token)) return;
      localChanged();
    },
    resolve(conversationId, turnId) {
      if (!turnId) return null;
      let best: (LiveAgentPhase & { source: string }) | null = null;
      const consider = (entry: LiveAgentPhase, source: string): void => {
        if (entry.conversationId !== conversationId || entry.turnId !== turnId) return;
        const candidate = { ...entry, source };
        if (!best || newer(candidate, best)) best = candidate;
      };
      for (const entry of local.values()) consider(entry, environment.windowId);
      const now = environment.now();
      for (const [windowId, state] of remote) {
        if (now - state.receivedAt >= LIVE_PHASE_REMOTE_TTL_MS) continue;
        for (const entry of state.entries) consider(entry, windowId);
      }
      return (best as (LiveAgentPhase & { source: string }) | null)?.phase ?? null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    receive,
    dispose() {
      if (disposed) return;
      if (local.size > 0) {
        local.clear();
        post("state");
      }
      post("bye");
      disposed = true;
      if (heartbeat !== null) environment.clearTimer(heartbeat);
      if (expiry !== null) environment.clearTimer(expiry);
      heartbeat = null;
      expiry = null;
      remote.clear();
      stopListening();
      stopUnload();
      environment.transport?.close();
      notify();
    },
  };
  return registry;
}

function browserTransport(): LivePhaseTransport | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const channel = new BroadcastChannel(LIVE_PHASE_CHANNEL_NAME);
  return {
    post: (message) => {
      try {
        channel.postMessage(message);
      } catch {
        return;
      }
    },
    listen: (listener) => {
      const onMessage = (event: MessageEvent): void => listener(event.data);
      channel.addEventListener("message", onMessage);
      return () => channel.removeEventListener("message", onMessage);
    },
    close: () => channel.close(),
  };
}

let sharedRegistry: LivePhaseRegistry | null = null;

export function sharedLivePhaseRegistry(): LivePhaseRegistry {
  if (sharedRegistry) return sharedRegistry;
  const browser = typeof window !== "undefined";
  sharedRegistry = createLivePhaseRegistry({
    now: () => Date.now(),
    windowId: typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `window-${Math.random().toString(36).slice(2)}`,
    transport: browser ? browserTransport() : null,
    setTimer: (callback, delayMs) => Number(globalThis.setTimeout(callback, delayMs)),
    clearTimer: (handle) => globalThis.clearTimeout(handle),
    onUnload: (listener) => {
      if (!browser) return () => undefined;
      window.addEventListener("pagehide", listener);
      return () => window.removeEventListener("pagehide", listener);
    },
  });
  return sharedRegistry;
}

export function usePublishLiveAgentPhase(
  entry: Omit<LiveAgentPhase, "at"> | null,
  registry: LivePhaseRegistry = sharedLivePhaseRegistry(),
): void {
  const token = useRef<symbol | null>(null);
  token.current ??= Symbol("live-agent-phase");
  const conversationId = entry?.conversationId ?? null;
  const turnId = entry?.turnId ?? null;
  const phase = entry?.phase ?? null;
  useLayoutEffect(() => {
    const key = token.current!;
    if (conversationId === null || turnId === null || phase === null) {
      registry.withdraw(key);
      return;
    }
    registry.publish(key, { conversationId, turnId, phase });
  }, [conversationId, phase, registry, turnId]);
  useLayoutEffect(() => {
    const key = token.current!;
    return () => registry.withdraw(key);
  }, [registry]);
}

export function useLiveAgentPhase(
  conversationId: string,
  turnId: string | null | undefined,
  registry: LivePhaseRegistry = sharedLivePhaseRegistry(),
): ActiveAgentPhase | null {
  return useSyncExternalStore(
    registry.subscribe,
    () => registry.resolve(conversationId, turnId),
    () => null,
  );
}
