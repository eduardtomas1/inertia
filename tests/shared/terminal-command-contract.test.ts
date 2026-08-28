import { describe, expect, it } from "vitest";

import { clientCommandSchema } from "../../src/shared/contracts";

describe("terminal command contract", () => {
  it("accepts only an exact terminal capability for detach", () => {
    const command = {
      type: "terminal.detach",
      requestId: "11111111-1111-4111-8111-111111111111",
      payload: { terminalId: "22222222-2222-4222-8222-222222222222" },
    } as const;
    expect(clientCommandSchema.parse(command)).toEqual(command);
    expect(clientCommandSchema.safeParse({
      ...command,
      payload: { ...command.payload, projectId: command.requestId },
    }).success).toBe(false);
  });
});
