import { DEFAULT_COMPLETION_SOUND } from "../completion-sound";
import { DEFAULT_QUOTA_WARNINGS } from "../quota-warnings";
import type { AppSnapshot } from "./app";
import type { ServerEvent } from "./events";

function completeSnapshot(snapshot: AppSnapshot): AppSnapshot {
  const { settings } = snapshot;
  if (settings.completionSound !== undefined && settings.quotaWarnings !== undefined && settings.notifyOnlyInBackground !== undefined) return snapshot;
  return { ...snapshot, settings: {
    ...settings,
    completionSound: settings.completionSound ?? { ...DEFAULT_COMPLETION_SOUND, library: [] },
    quotaWarnings: settings.quotaWarnings ?? { ...DEFAULT_QUOTA_WARNINGS },
    notifyOnlyInBackground: settings.notifyOnlyInBackground ?? false,
  } };
}

function completeServerEvent(event: ServerEvent): ServerEvent {
  if (event.type === "server.welcome" || event.type === "snapshot.updated") {
    const snapshot = completeSnapshot(event.snapshot);
    return snapshot === event.snapshot ? event : { ...event, snapshot };
  }
  if (event.type === "runtime.event" && event.event.type === "snapshot.updated") {
    const snapshot = completeSnapshot(event.event.snapshot);
    return snapshot === event.event.snapshot ? event : { ...event, event: { ...event.event, snapshot } };
  }
  return event;
}

export function serverEventBoundary(validate: (value: unknown) => value is ServerEvent) {
  const parse = (value: unknown): ServerEvent => {
    if (!validate(value)) throw new Error("Malformed server event");
    return completeServerEvent(value);
  };
  return Object.freeze({
    parse,
    safeParse(value: unknown): { success: true; data: ServerEvent } | { success: false; error: Error } {
      try { return { success: true, data: parse(value) }; }
      catch (error) { return { success: false, error: error instanceof Error ? error : new Error("Malformed server event") }; }
    },
  });
}
