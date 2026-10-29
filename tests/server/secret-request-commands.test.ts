import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { answerRuntimeAgentSecretDelivery } from "../../src/server/runtime-agent-secret-delivery";
import {
  createSecretRequestCommandHandler,
  SECRET_REQUEST_NOT_ACTIVE_MESSAGE,
  SECRET_REQUEST_NOT_PENDING_MESSAGE,
} from "../../src/server/runtime/commands/secret-request-commands";
import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";

const SECRET = "tskey-auth-kQ9xZ2mB7vN4pL1sR8tW";

function handlerWith(service: Parameters<typeof createSecretRequestCommandHandler>[0]["service"]) {
  const sent: ServerEvent[] = [];
  const handler = createSecretRequestCommandHandler({ service, send: (_socket, event) => sent.push(event) });
  const run = (command: Omit<ClientCommand, "requestId">) =>
    handler({} as Parameters<typeof handler>[0], { ...command, requestId: randomUUID() } as ClientCommand);
  return { sent, run };
}

describe("secret request commands", () => {
  it("decline, revoke and list go to the service and answer without values or paths", async () => {
    const entry = {
      requestId: randomUUID(), conversationId: randomUUID(), conversationTitle: "Tailscale", title: "Tailscale auth key",
      answeredAt: "2026-10-29T12:00:00.000Z", expiresAt: "2026-10-30T12:00:00.000Z", storage: "keychain" as const,
    };
    const service = {
      decline: vi.fn(async () => true),
      revoke: vi.fn(async () => true),
      list: vi.fn(() => [entry]),
    };
    const { sent, run } = handlerWith(() => service);
    const conversationId = randomUUID();
    const requestId = randomUUID();
    await expect(run({ type: "secret-request.decline", payload: { conversationId, requestId } } as never)).resolves.toBe("handled");
    await expect(run({ type: "secret-request.revoke", payload: { requestId } } as never)).resolves.toBe("handled");
    await expect(run({ type: "secret-request.list", payload: {} } as never)).resolves.toBe("handled");
    expect(service.decline).toHaveBeenCalledWith(conversationId, requestId);
    expect(service.revoke).toHaveBeenCalledWith(requestId);
    expect(sent.map((event) => event.type === "request.result" ? event.result : null)).toEqual([
      { kind: "secret-request.decline", status: "declined" },
      { kind: "secret-request.revoke", status: "revoked" },
      { kind: "secret-request.list", secrets: [entry] },
    ]);
  });

  it("answers fixed messages when the request is no longer pending or active, or the service is missing", async () => {
    const refusing = handlerWith(() => ({ decline: async () => false, revoke: async () => false, list: () => [] }));
    await expect(refusing.run({ type: "secret-request.decline", payload: { conversationId: randomUUID(), requestId: randomUUID() } } as never))
      .rejects.toThrow(SECRET_REQUEST_NOT_PENDING_MESSAGE);
    await expect(refusing.run({ type: "secret-request.revoke", payload: { requestId: randomUUID() } } as never))
      .rejects.toThrow(SECRET_REQUEST_NOT_ACTIVE_MESSAGE);
    const missing = handlerWith(() => null);
    await expect(missing.run({ type: "secret-request.decline", payload: { conversationId: randomUUID(), requestId: randomUUID() } } as never))
      .rejects.toThrow(SECRET_REQUEST_NOT_PENDING_MESSAGE);
    await missing.run({ type: "secret-request.list", payload: {} } as never);
    expect(missing.sent).toEqual([expect.objectContaining({ result: { kind: "secret-request.list", secrets: [] } })]);
  });
});

describe("runtime worker secret delivery answer", () => {
  const command = {
    type: "runtime.agent-secret-deliver" as const,
    transportId: randomUUID(),
    conversationId: randomUUID(),
    requestId: randomUUID(),
    secret: SECRET,
    vaulted: true,
  };

  it("maps the service outcome to delivered or rejected events that never carry the value", async () => {
    const delivered = await answerRuntimeAgentSecretDelivery({
      deliverAgentSecret: async () => ({ status: "delivered", expiresAt: "2026-10-30T12:00:00.000Z", storage: "keychain" }),
    }, command);
    expect(delivered).toEqual({
      type: "runtime.agent-secret-delivered", transportId: command.transportId,
      expiresAt: "2026-10-30T12:00:00.000Z", storage: "keychain",
    });
    const rejected = await answerRuntimeAgentSecretDelivery({
      deliverAgentSecret: async () => ({ status: "rejected", reason: "limit" }),
    }, command);
    expect(rejected).toEqual({ type: "runtime.agent-secret-rejected", transportId: command.transportId, reason: "limit" });
    const thrown = await answerRuntimeAgentSecretDelivery({
      deliverAgentSecret: async () => {
        throw new Error(`EACCES writing ${SECRET}`);
      },
    }, command);
    expect(thrown).toEqual({ type: "runtime.agent-secret-rejected", transportId: command.transportId, reason: "file-failed" });
    const stopped = await answerRuntimeAgentSecretDelivery(null, command);
    expect(stopped).toEqual({ type: "runtime.agent-secret-rejected", transportId: command.transportId, reason: "ended" });
    expect(JSON.stringify([delivered, rejected, thrown, stopped])).not.toContain(SECRET);
  });
});
