// @inertia-test-suite portable
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../src/server/codex/protocol";
import { createAgentHarnessEmitter, type AgentHarnessEvent } from "../../src/server/provider/agent-harness";
import { AcpSecretRedactor } from "../../src/server/provider/acp-redaction";
import { PiDialogs } from "../../src/server/provider/pi-dialogs";

function fixture() {
  const output: AgentHarnessEvent[] = []; const replies: JsonObject[] = [];
  const emit = createAgentHarnessEmitter("pi", "chat", { onEvent: (event) => output.push(event) }, "run", "turn");
  const dialogs = new PiDialogs(emit, new AcpSecretRedactor({ TEST_API_KEY: "fixture-secret" }), (reply) => replies.push(reply), "managed-approval");
  const inputIds = () => output.flatMap((event) => event.type === "extension" && event.event.type === "input" ? [event.event.request.requestId] : []);
  return { output, replies, dialogs, inputIds };
}

describe("Pi extension dialog authority", () => {
  it("keeps secret-bearing native IDs private and returns exact native values", () => {
    const f = fixture();
    try {
      for (const id of ["fixture-secret:first", "fixture-secret:second"]) f.dialogs.receive({ id, method: "select", title: "fixture-secret", options: ["fixture-secret:choice", "public"] });
      const ids = f.inputIds(); expect(new Set(ids).size).toBe(2);
      expect(JSON.stringify(f.output)).not.toContain("fixture-secret");
      expect(f.dialogs.input("pi-ui:fixture-secret:first", { answer: ["0"] })).toBe(false);
      expect(f.dialogs.input(ids[0]!, { answer: ["0"] })).toBe(true);
      expect(f.dialogs.input(ids[0]!, { answer: ["1"] })).toBe(false);
      expect(f.replies[0]).toEqual({ type: "extension_ui_response", id: "fixture-secret:first", value: "fixture-secret:choice" });
      expect(JSON.stringify(f.output)).not.toContain("fixture-secret");
    } finally { f.dialogs.close(); }
  });
  it("rejects unrelated answers without consuming the pending dialog", () => {
    const f = fixture();
    try {
      f.dialogs.receive({ id: "native", method: "input", title: "Answer" });
      const id = f.inputIds()[0]!;
      expect(f.dialogs.input(id, { unrelated: ["yes"] })).toBe(false);
      expect(f.dialogs.input(id, { answer: ["yes"], unrelated: [] })).toBe(false);
      expect(f.replies).toEqual([]);
      expect(f.dialogs.input(id, { answer: ["correct"] })).toBe(true);
      expect(f.replies).toEqual([{ type: "extension_ui_response", id: "native", value: "correct" }]);
    } finally { f.dialogs.close(); }
  });
  it("binds approval replies to the opaque request and cancels other dialogs on close", () => {
    const f = fixture();
    f.dialogs.receive({ id: "native-approval", method: "confirm", title: "managed-approval", message: "Allow?" });
    f.dialogs.receive({ id: "native-input", method: "editor", title: "Edit" });
    const approvalId = f.output.flatMap((event) => event.type === "extension" && event.event.type === "approval" ? [event.event.request.requestId] : [])[0]!;
    expect(f.dialogs.input(approvalId, { answer: ["yes"] })).toBe(false);
    expect(f.dialogs.approval(approvalId, "approve")).toBe(true);
    f.dialogs.close(); f.dialogs.close();
    expect(f.replies).toEqual([{ type: "extension_ui_response", id: "native-approval", confirmed: true }, { type: "extension_ui_response", id: "native-input", cancelled: true }]);
    expect(f.dialogs.approval(approvalId, "approve")).toBe(false);
  });
});
