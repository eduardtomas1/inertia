import type WebSocket from "ws";

import {
  clientCommandSchema,
  type ClientCommand,
  type ServerEvent,
} from "../../../shared/contracts";

export type RuntimeCommandDisposition =
  | "not-handled"
  | "handled"
  | "mutation";

export interface RuntimeCommandHandler {
  (
    socket: WebSocket,
    command: ClientCommand,
  ): Promise<RuntimeCommandDisposition>;
  readonly commandTypes?: readonly ClientCommand["type"][];
}

export interface RuntimeCommandRouterOptions {
  handlers: readonly RuntimeCommandHandler[];
  send(socket: WebSocket, event: ServerEvent): void;
  broadcastSnapshot(): void;
  publicError(error: unknown): string;
}

export const RUNTIME_COMMAND_TYPES = Object.freeze(
  clientCommandSchema.options.flatMap((schema) => {
    const type = schema.shape.type;
    if ("options" in type) {
      return [...type.options] as ClientCommand["type"][];
    }
    if ("values" in type) {
      return [...type.values] as ClientCommand["type"][];
    }
    return [];
  }),
);

export function defineRuntimeCommandHandler(
  commandTypes: readonly ClientCommand["type"][],
  handler: RuntimeCommandHandler,
): RuntimeCommandHandler {
  return Object.assign(handler, { commandTypes });
}

function indexCommandOwners(
  handlers: readonly RuntimeCommandHandler[],
): ReadonlyMap<ClientCommand["type"], RuntimeCommandHandler> {
  const owners = new Map<ClientCommand["type"], {
    handler: RuntimeCommandHandler;
    index: number;
  }>();
  handlers.forEach((handler, handlerIndex) => {
    if (!handler.commandTypes?.length) {
      throw new Error(
        `Runtime command handler ${handlerIndex} does not declare ownership.`,
      );
    }
    for (const type of handler.commandTypes) {
      const previous = owners.get(type);
      if (previous) {
        throw new Error(
          `Runtime command ${type} is owned by handlers ${previous.index} and ${handlerIndex}.`,
        );
      }
      owners.set(type, { handler, index: handlerIndex });
    }
  });
  for (const type of RUNTIME_COMMAND_TYPES) {
    if (!owners.has(type)) {
      throw new Error(`Runtime command ${type} does not have an owner.`);
    }
  }
  return new Map(
    [...owners].map(([type, owner]) => [type, owner.handler]),
  );
}

/**
 * Keeps request settlement and mutation ordering in one place while domain
 * handlers own only their commands. Mutations publish the authoritative
 * snapshot before request.ok so immediate follow-up actions cannot target
 * stale renderer state.
 */
export function createRuntimeCommandExecutor(
  options: RuntimeCommandRouterOptions,
): (socket: WebSocket, command: ClientCommand) => Promise<void> {
  const owners = indexCommandOwners(options.handlers);
  return async (socket, command) => {
    try {
      const handler = owners.get(command.type);
      if (!handler) {
        throw new Error(`No runtime command handler owns ${command.type}.`);
      }
      const disposition = await handler(socket, command);
      if (disposition === "not-handled") {
        throw new Error(
          `Runtime command handler rejected its owned command ${command.type}.`,
        );
      }
      if (disposition === "mutation") {
        options.broadcastSnapshot();
        options.send(socket, {
          type: "request.ok",
          requestId: command.requestId,
        });
      }
    } catch (error) {
      options.send(socket, {
        type: "request.error",
        requestId: command.requestId,
        message: options.publicError(error),
      });
    }
  };
}
