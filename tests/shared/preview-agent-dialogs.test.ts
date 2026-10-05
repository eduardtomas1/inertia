import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import {
  installPreviewAgentDialogPolicy,
  installPreviewAgentDialogRecorder,
  type PreviewAgentDialog,
} from "../../src/shared/preview-agent-dialogs";

function page() {
  const target = new EventTarget();
  const main: Record<string, unknown> = {
    addEventListener: target.addEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    CustomEvent,
    alert: () => { throw new Error("native alert"); },
    confirm: () => { throw new Error("native confirm"); },
    prompt: () => { throw new Error("native prompt"); },
  };
  const isolated: Record<string, unknown> = {
    addEventListener: target.addEventListener.bind(target),
  };
  runInNewContext(`(${installPreviewAgentDialogPolicy.toString()})("dialog", "answer", 1024, 20)`, main);
  runInNewContext(`(${installPreviewAgentDialogRecorder.toString()})("dialog", 1024, 20)`, isolated);
  const records = (): PreviewAgentDialog[] => (isolated.__inertiaAgentDialogs as { records: PreviewAgentDialog[] }).records
    .map(({ kind, message, answer }) => ({ kind, message, answer }));
  const truncated = (): boolean[] => (isolated.__inertiaAgentDialogs as { records: Array<{ truncated: boolean }> }).records
    .map((record) => record.truncated);
  const arm = (answer: string): void => {
    target.dispatchEvent(new CustomEvent("answer", { detail: answer }));
  };
  return { main, records, truncated, arm, target };
}

describe("Browser dialog policy", () => {
  it("answers without a native dialog and records each call for the agent", () => {
    const { main, records, arm } = page();
    expect(runInNewContext("alert('Saved')", main)).toBeUndefined();
    expect(runInNewContext("confirm('Delete?')", main)).toBe(false);
    expect(runInNewContext("prompt('Name?')", main)).toBeNull();
    arm("accept");
    expect(runInNewContext("confirm('Really delete?')", main)).toBe(true);
    expect(runInNewContext("prompt('Name?')", main)).toBeNull();
    arm("dismiss");
    expect(runInNewContext("confirm({ toString() { return 'Object message'; } })", main)).toBe(false);
    expect(records()).toEqual([
      { kind: "alert", message: "Saved", answer: "accept" },
      { kind: "confirm", message: "Delete?", answer: "dismiss" },
      { kind: "prompt", message: "Name?", answer: "dismiss" },
      { kind: "confirm", message: "Really delete?", answer: "accept" },
      { kind: "prompt", message: "Name?", answer: "dismiss" },
      { kind: "confirm", message: "Object message", answer: "dismiss" },
    ]);
  });

  it("bounds each message to 1,024 characters and each document to 20 dialogs", () => {
    const { main, records, truncated } = page();
    runInNewContext("alert('x'.repeat(5000)); alert('short')", main);
    expect(records()[0]!.message).toHaveLength(1_024);
    expect(truncated().slice(0, 2)).toEqual([true, false]);
    runInNewContext("for (let index = 0; index < 40; index += 1) alert(String(index))", main);
    expect(records()).toHaveLength(20);
    expect(records().at(-1)).toEqual({ kind: "alert", message: "17", answer: "accept" });
  });

  it("keeps working after the page replaces the built-ins it would use", () => {
    const { main, records } = page();
    runInNewContext(`
      JSON.stringify = () => "[]";
      String.prototype.slice = () => "tampered";
      Object.prototype.detail = "tampered";
      CustomEvent = function () { throw new Error("tampered"); };
    `, main);
    expect(runInNewContext("confirm('Delete?')", main)).toBe(false);
    expect(records()).toEqual([{ kind: "confirm", message: "Delete?", answer: "dismiss" }]);
  });

  it("ignores forged or oversized records", () => {
    const { records, target } = page();
    for (const detail of [
      JSON.stringify(["eval", "x", "accept", false]),
      JSON.stringify(["alert", "x", "maybe", false]),
      JSON.stringify(["alert", "x".repeat(1_025), "accept", false]),
      JSON.stringify(["alert", 1, "accept", false]),
      JSON.stringify(["alert", "x", "accept"]),
      "not json",
      42,
    ]) target.dispatchEvent(new CustomEvent("dialog", { detail }));
    expect(records()).toEqual([]);
  });
});
