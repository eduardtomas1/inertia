import type { ClientCommand } from "../../../shared/contracts";
import { RuntimeRequestError } from "../../runtime-errors";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";

export const WATCHER_COMMAND_TYPES = [
  "watcher.attach",
  "watcher.update",
  "watcher.pause",
  "watcher.resume",
  "watcher.wake",
  "watcher.detach",
  "watcher.feed.get",
  "watcher.note.deliver",
  "watcher.note.dismiss",
] as const satisfies readonly Extract<ClientCommand["type"], `watcher.${string}`>[];

/**
 * Owns the watcher commands until the watcher runtime is wired. Every
 * command fails closed with a request error; nothing is read or written.
 */
export function createUnavailableWatcherCommandHandler(): RuntimeCommandHandler {
  return defineRuntimeCommandHandler(WATCHER_COMMAND_TYPES, () =>
    Promise.reject(new RuntimeRequestError("Watchers are not available in this version yet.")));
}
