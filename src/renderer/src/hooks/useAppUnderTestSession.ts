import { useCallback, useEffect, useReducer, useRef } from "react";

import type { AppUnderTestLaunch } from "@shared/app-under-test";
import type { ClientCommand, ServerEvent } from "@shared/contracts";
import {
  resultEvent,
  withRequestId,
  type CommandWithoutId,
  type ResultEvent,
} from "../lib/runtimeCommands";
import {
  appSessionReducer,
  emptyAppSession,
  isLiveLaunch,
  type AppSessionState,
} from "../utils/appUnderTestSession";
import type { ConnectionStatus } from "./useInertiaConnection";

export interface AppUnderTestSessionOptions {
  conversationId: string | null;
  status: ConnectionStatus;
  /** The launch the user picked, if any; an exited one's retained tail is read once. Defaults to the newest. */
  focusLaunchId: string | null;
  sendCommand: (command: ClientCommand) => Promise<ServerEvent>;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  onError: (message: string) => void;
}

export type AppLaunchRequest = { kind: "electron" } | { kind: "action"; actionId: string };

export interface AppUnderTestSession {
  state: AppSessionState;
  launch: (request: AppLaunchRequest) => Promise<AppUnderTestLaunch | null>;
  stop: (launchId: string) => Promise<AppUnderTestLaunch | null>;
}

const LOG_PAGE_LINES = 200;

export function appUnderTestErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * One chat's App session for the mounted App surface. State is local to the
 * surface, like the agent workflow projection: launches and evidence are
 * reread on mount and after every reconnect, replayed mutations keep them
 * current, and live log lines merge by cursor with each launch's newest tail.
 */
export function useAppUnderTestSession({
  conversationId,
  status,
  focusLaunchId,
  sendCommand,
  subscribe,
  onError,
}: AppUnderTestSessionOptions): AppUnderTestSession {
  const [state, dispatch] = useReducer(appSessionReducer, undefined, emptyAppSession);
  const online = status === "online";
  const generation = useRef(0);
  const logReads = useRef(new Set<string>());
  const evidenceRefresh = useRef({ running: false, again: false });
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  });

  const request = useCallback(async (command: CommandWithoutId): Promise<ResultEvent["result"]> => (
    resultEvent(await sendCommand(withRequestId(command))).result
  ), [sendCommand]);

  const refreshEvidence = useCallback((): void => {
    if (!conversationId) return;
    const refresh = evidenceRefresh.current;
    if (refresh.running) {
      refresh.again = true;
      return;
    }
    refresh.running = true;
    const current = generation.current;
    void (async () => {
      try {
        do {
          refresh.again = false;
          try {
            const result = await request({ type: "app-under-test.evidence.list", payload: { conversationId } });
            if (generation.current === current && result.kind === "app-under-test.evidence") {
              dispatch({ type: "evidence", evidence: result.evidence });
            }
          } catch {
            // A missed thumbnail refresh is retried by the next evidence event or reconnect.
          }
        } while (refresh.again && generation.current === current);
      } finally {
        refresh.running = false;
      }
    })();
  }, [conversationId, request]);

  useEffect(() => {
    if (!conversationId) return;
    return subscribe((event) => {
      switch (event.type) {
        case "app-under-test.launch.updated":
          if (event.conversationId === conversationId) dispatch({ type: "launch", launch: event.launch });
          return;
        case "app-under-test.windows.updated":
          if (event.conversationId === conversationId) {
            dispatch({ type: "windows", launchId: event.launchId, windows: event.windows });
          }
          return;
        case "app-under-test.evidence.appended":
          if (event.conversationId !== conversationId) return;
          dispatch({ type: "evidence.appended", evidence: event.evidence });
          if (event.evidence.hasThumbnail) refreshEvidence();
          return;
        case "app-under-test.logs.appended":
          if (event.conversationId === conversationId) {
            dispatch({ type: "logs", launchId: event.launchId, lines: event.lines });
          }
          return;
        case "app-under-test.session.cleared":
          if (event.conversationId !== conversationId) return;
          logReads.current = new Set();
          dispatch({ type: "cleared" });
          return;
        default:
          return;
      }
    });
  }, [conversationId, refreshEvidence, subscribe]);

  useEffect(() => {
    if (!conversationId || !online) return;
    generation.current += 1;
    const current = generation.current;
    logReads.current = new Set();
    void (async () => {
      try {
        const [launches, evidence] = await Promise.all([
          request({ type: "app-under-test.launches.list", payload: { conversationId } }),
          request({ type: "app-under-test.evidence.list", payload: { conversationId } }),
        ]);
        if (generation.current !== current) return;
        if (launches.kind === "app-under-test.launches") dispatch({ type: "launches", launches: launches.launches });
        if (evidence.kind === "app-under-test.evidence") dispatch({ type: "evidence", evidence: evidence.evidence });
      } catch (error) {
        if (generation.current === current) {
          onErrorRef.current(appUnderTestErrorMessage(error, "The App session could not be loaded."));
        }
      }
    })();
  }, [conversationId, online, request]);

  // Read the newest retained tail once per launch per (re)load; live events
  // follow from there and merge by cursor, so overlap is harmless.
  useEffect(() => {
    if (!conversationId || !online || !state.loaded) return;
    const current = generation.current;
    const focused = focusLaunchId ?? state.launches.at(-1)?.launchId ?? null;
    for (const launch of state.launches) {
      if (!isLiveLaunch(launch) && launch.launchId !== focused) continue;
      if (logReads.current.has(launch.launchId)) continue;
      logReads.current.add(launch.launchId);
      const { launchId } = launch;
      void request({
        type: "app-under-test.logs.read",
        payload: { conversationId, launchId, limit: LOG_PAGE_LINES },
      }).then((result) => {
        if (generation.current === current && result.kind === "app-under-test.logs") {
          dispatch({ type: "logs", launchId, lines: result.lines });
        }
      }, () => {
        // The launch may have been cleared meanwhile; the next reload retries.
      });
    }
  }, [conversationId, focusLaunchId, online, request, state.launches, state.loaded]);

  const launch = useCallback(async (input: AppLaunchRequest): Promise<AppUnderTestLaunch | null> => {
    if (!conversationId) return null;
    const result = await request({
      type: "app-under-test.launch",
      payload: input.kind === "action"
        ? { conversationId, kind: "action", actionId: input.actionId }
        : { conversationId, kind: "electron" },
    });
    if (result.kind !== "app-under-test.launch") return null;
    dispatch({ type: "launch", launch: result.launch });
    return result.launch;
  }, [conversationId, request]);

  const stop = useCallback(async (launchId: string): Promise<AppUnderTestLaunch | null> => {
    if (!conversationId) return null;
    const result = await request({ type: "app-under-test.stop", payload: { conversationId, launchId } });
    if (result.kind !== "app-under-test.launch") return null;
    dispatch({ type: "launch", launch: result.launch });
    return result.launch;
  }, [conversationId, request]);

  return { state, launch, stop };
}
