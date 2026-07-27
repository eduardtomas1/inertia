import type WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";

import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";
import {
  createRuntimeCommandExecutor,
  defineRuntimeCommandHandler,
  RUNTIME_COMMAND_TYPES,
  type RuntimeCommandHandler,
} from "../../src/server/runtime/commands/command-router";

function command(type: ClientCommand["type"] = "project.select"): ClientCommand {
  if (type !== "project.select") {
    throw new Error(`Unsupported command fixture: ${type}`);
  }
  return {
    type,
    requestId: crypto.randomUUID(),
    payload: { projectId: crypto.randomUUID() },
  };
}

describe("runtime command router", () => {
  const allCommands = (
    handler: RuntimeCommandHandler,
  ): RuntimeCommandHandler => defineRuntimeCommandHandler(
    RUNTIME_COMMAND_TYPES,
    handler,
  );

  it("publishes a mutation snapshot before settling the request", async () => {
    const order: string[] = [];
    const selected = command();
    const execute = createRuntimeCommandExecutor({
      handlers: [
        allCommands(async () => "mutation"),
      ],
      broadcastSnapshot: () => order.push("snapshot"),
      send: (_socket, event) => order.push(
        event.type === "request.ok" ? "request.ok" : event.type,
      ),
      publicError: () => "hidden",
    });

    await execute({} as WebSocket, selected);

    expect(order).toEqual(["snapshot", "request.ok"]);
  });

  it("does not add settlement for a handler that owns its response", async () => {
    const events: ServerEvent[] = [];
    const selected = command();
    const execute = createRuntimeCommandExecutor({
      handlers: [
        allCommands(
          async (socket, current) => {
            events.push({
              type: "request.ok",
              requestId: current.requestId,
            });
            void socket;
            return "handled";
          },
        ),
      ],
      broadcastSnapshot: vi.fn(),
      send: (_socket, event) => events.push(event),
      publicError: () => "hidden",
    });

    await execute({} as WebSocket, selected);

    expect(events).toEqual([{
      type: "request.ok",
      requestId: selected.requestId,
    }]);
  });

  it("routes only to the declared owner and sanitizes thrown failures", async () => {
    const unrelated = vi.fn<RuntimeCommandHandler>(
      async () => "handled",
    );
    const owner = vi.fn<RuntimeCommandHandler>(async () => {
      throw new Error("private detail");
    });
    const events: ServerEvent[] = [];
    const selected = command();
    const execute = createRuntimeCommandExecutor({
      handlers: [
        defineRuntimeCommandHandler(["app.refresh"], unrelated),
        defineRuntimeCommandHandler(
          RUNTIME_COMMAND_TYPES.filter((type) => type !== "app.refresh"),
          owner,
        ),
      ],
      broadcastSnapshot: vi.fn(),
      send: (_socket, event) => events.push(event),
      publicError: () => "Safe failure.",
    });

    await execute({} as WebSocket, selected);

    expect(unrelated).not.toHaveBeenCalled();
    expect(owner).toHaveBeenCalledOnce();
    expect(events).toEqual([{
      type: "request.error",
      requestId: selected.requestId,
      message: "Safe failure.",
    }]);
  });

  it("rejects overlapping command ownership before accepting requests", () => {
    const first = allCommands(async () => "handled");
    const second = defineRuntimeCommandHandler(
      ["project.select"],
      async () => "handled",
    );

    expect(() => createRuntimeCommandExecutor({
      handlers: [first, second],
      broadcastSnapshot: vi.fn(),
      send: vi.fn(),
      publicError: () => "hidden",
    })).toThrow(
      "Runtime command project.select is owned by handlers 0 and 1.",
    );
  });

  it("rejects missing command ownership before accepting requests", () => {
    const incomplete = defineRuntimeCommandHandler(
      RUNTIME_COMMAND_TYPES.filter((type) => type !== "project.select"),
      async () => "handled",
    );

    expect(() => createRuntimeCommandExecutor({
      handlers: [incomplete],
      broadcastSnapshot: vi.fn(),
      send: vi.fn(),
      publicError: () => "hidden",
    })).toThrow(
      "Runtime command project.select does not have an owner.",
    );
  });
});
