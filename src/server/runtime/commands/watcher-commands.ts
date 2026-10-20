import type WebSocket from "ws";
import type { z } from "zod";

import type { ClientCommand, ServerEvent } from "../../../shared/contracts";
import {
  watcherAttachPayloadSchema,
  watcherCommandSchemas,
  watcherUpdatePayloadSchema,
} from "../../../shared/contracts/client-command/watcher";
import { RuntimeRequestError } from "../../runtime-errors";
import type { WatcherDeliveryService } from "../watcher/watcher-delivery";
import type { WatcherLinkCoordinator } from "../watcher/watcher-link-coordinator";
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

type WatcherCommand = Extract<ClientCommand, { type: (typeof WATCHER_COMMAND_TYPES)[number] }>;

export interface WatcherCommandDependencies {
  coordinator: Pick<
    WatcherLinkCoordinator,
    "attach" | "update" | "pause" | "resume" | "wake" | "detach" | "feed"
  >;
  delivery: Pick<WatcherDeliveryService, "deliver" | "dismiss">;
  send(socket: WebSocket, event: ServerEvent): void;
}

const [, , linkCommandSchema, feedCommandSchema, deliverCommandSchema, dismissCommandSchema] = watcherCommandSchemas;

function parsed<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new RuntimeRequestError("The watcher request was invalid.");
  return result.data;
}

/**
 * Owns the nine watcher commands. Payloads are validated again at this
 * boundary; every result is one of `watcher.link`, `watcher.feed` or
 * `watcher.delivery`. Note delivery is always an explicit user command.
 */
export function createWatcherCommandHandler(dependencies: WatcherCommandDependencies): RuntimeCommandHandler {
  const { coordinator, delivery } = dependencies;
  return defineRuntimeCommandHandler(WATCHER_COMMAND_TYPES, async (socket, untyped) => {
    if (!(WATCHER_COMMAND_TYPES as readonly string[]).includes(untyped.type)) return "not-handled";
    const command = untyped as WatcherCommand;
    const reply = (result: Extract<ServerEvent, { type: "request.result" }>["result"]): "handled" => {
      dependencies.send(socket, { type: "request.result", requestId: command.requestId, result });
      return "handled";
    };
    switch (command.type) {
      case "watcher.attach":
        return reply({ kind: "watcher.link", link: await coordinator.attach(parsed(watcherAttachPayloadSchema, command.payload)) });
      case "watcher.update":
        return reply({ kind: "watcher.link", link: coordinator.update(parsed(watcherUpdatePayloadSchema, command.payload)) });
      case "watcher.pause":
      case "watcher.resume":
      case "watcher.wake":
      case "watcher.detach": {
        const { linkId } = parsed(linkCommandSchema, command).payload;
        const link = command.type === "watcher.pause"
          ? coordinator.pause(linkId)
          : command.type === "watcher.resume"
            ? await coordinator.resume(linkId)
            : command.type === "watcher.wake" ? coordinator.wake(linkId) : coordinator.detach(linkId);
        return reply({ kind: "watcher.link", link });
      }
      case "watcher.feed.get": {
        const { linkId, beforeSequence } = parsed(feedCommandSchema, command).payload;
        return reply(coordinator.feed(linkId, beforeSequence));
      }
      case "watcher.note.deliver": {
        const { linkId, wakeId, mode, deliveryId } = parsed(deliverCommandSchema, command).payload;
        return reply(await delivery.deliver(linkId, wakeId, mode, deliveryId));
      }
      case "watcher.note.dismiss": {
        const { linkId, wakeId } = parsed(dismissCommandSchema, command).payload;
        return reply(delivery.dismiss(linkId, wakeId));
      }
      default:
        return "not-handled";
    }
  });
}
