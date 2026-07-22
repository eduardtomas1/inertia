import { describe, expect, it } from "vitest";
import { clientCommandSchema } from "../src/shared/contracts";

describe("client command contract", () => {
  it("accepts a bounded message command", () => {
    const command = {
      type: "message.send",
      requestId: crypto.randomUUID(),
      payload: {
        conversationId: crypto.randomUUID(),
        content: "Make the workspace calmer.",
      },
    };

    expect(clientCommandSchema.parse(command)).toEqual({
      ...command,
      payload: { ...command.payload, attachments: [] },
    });
  });

  it("rejects unknown command fields", () => {
    const command = {
      type: "app.refresh",
      requestId: crypto.randomUUID(),
      unexpected: true,
    };

    expect(clientCommandSchema.safeParse(command).success).toBe(false);
  });

  it("rejects unreasonable terminal dimensions", () => {
    const command = {
      type: "terminal.resize",
      requestId: crypto.randomUUID(),
      payload: {
        terminalId: crypto.randomUUID(),
        cols: 10_000,
        rows: 10_000,
      },
    };

    expect(clientCommandSchema.safeParse(command).success).toBe(false);
  });

  it("accepts bounded provider refresh commands", () => {
    const refreshAll = {
      type: "provider.refresh",
      requestId: crypto.randomUUID(),
      payload: {},
    };
    const refreshOne = {
      type: "provider.refresh",
      requestId: crypto.randomUUID(),
      payload: { providerId: "codex" },
    };

    expect(clientCommandSchema.parse(refreshAll)).toEqual(refreshAll);
    expect(clientCommandSchema.parse(refreshOne)).toEqual(refreshOne);
  });

  it("accepts provider authentication terminals at their dimension boundaries", () => {
    for (const [cols, rows] of [[40, 10], [240, 80]] as const) {
      const command = {
        type: "provider.auth.start",
        requestId: crypto.randomUUID(),
        payload: { providerId: "claude", cols, rows },
      };

      expect(clientCommandSchema.parse(command)).toEqual(command);
    }
  });

  it("rejects malformed provider refresh and authentication commands", () => {
    const requestId = crypto.randomUUID();
    const invalid = [
      { type: "provider.refresh", requestId },
      { type: "provider.refresh", requestId, payload: { providerId: "unknown" } },
      { type: "provider.refresh", requestId, payload: { providerId: "codex", unexpected: true } },
      { type: "provider.auth.start", requestId, payload: { providerId: "unknown", cols: 80, rows: 24 } },
      { type: "provider.auth.start", requestId, payload: { providerId: "codex", cols: 39, rows: 24 } },
      { type: "provider.auth.start", requestId, payload: { providerId: "codex", cols: 80, rows: 81 } },
      { type: "provider.auth.start", requestId, payload: { providerId: "codex", cols: 80, rows: 24, token: "never" } },
    ];

    for (const command of invalid) expect(clientCommandSchema.safeParse(command).success).toBe(false);
  });
});
