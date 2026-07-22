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
});
