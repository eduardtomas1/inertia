import { describe, expect, it } from "vitest";

import {
  clientCommandSchema,
  MAX_WORKSPACE_FILE_EDIT_BYTES,
} from "../src/shared/contracts";
import {
  RUNTIME_WEBSOCKET_MAX_PAYLOAD_BYTES,
  serializeRuntimeClientCommand,
} from "../src/shared/runtime-websocket";

function workspaceWrite(content: string) {
  return clientCommandSchema.parse({
    type: "workspace.file.write",
    requestId: "11111111-1111-4111-8111-111111111111",
    payload: {
      projectId: "22222222-2222-4222-8222-222222222222",
      conversationId: "33333333-3333-4333-8333-333333333333",
      path: "src/example.ts",
      authorityRef: "44444444-4444-4444-8444-444444444444",
      expectedDigest: "a".repeat(64),
      content,
    },
  });
}

describe("runtime WebSocket command serialization", () => {
  it("preserves the full useful edit capacity for ordinary UTF-8 text", () => {
    const serialized = serializeRuntimeClientCommand(
      workspaceWrite("x".repeat(MAX_WORKSPACE_FILE_EDIT_BYTES)),
    );

    expect(new TextEncoder().encode(serialized).byteLength)
      .toBeLessThanOrEqual(RUNTIME_WEBSOCKET_MAX_PAYLOAD_BYTES);
  });

  it.each([
    ["quotes", "\""],
    ["backslashes", "\\"],
    ["tabs", "\t"],
    ["newlines", "\n"],
  ])("rejects %s when JSON escaping exceeds the transport frame", (
    _label,
    value,
  ) => {
    const command = workspaceWrite(value.repeat(140_000));
    expect(clientCommandSchema.safeParse(command).success).toBe(true);

    expect(() => serializeRuntimeClientCommand(command))
      .toThrow("The request is too large to send.");
  });

  it("rejects worst-case Unicode escaping without shrinking normal Unicode edits", () => {
    const escapedSurrogates = workspaceWrite("\ud800".repeat(50_000));
    expect(clientCommandSchema.safeParse(escapedSurrogates).success).toBe(true);
    expect(() => serializeRuntimeClientCommand(escapedSurrogates))
      .toThrow("The request is too large to send.");

    const ordinaryUnicode = serializeRuntimeClientCommand(
      workspaceWrite("🙂".repeat(40_000)),
    );
    expect(new TextEncoder().encode(ordinaryUnicode).byteLength)
      .toBeLessThanOrEqual(RUNTIME_WEBSOCKET_MAX_PAYLOAD_BYTES);
  });
});
