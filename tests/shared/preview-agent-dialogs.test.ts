import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import {
  armPreviewAgentDialogAnswer,
  installPreviewAgentDialogPolicy,
  installPreviewAgentDialogRecorder,
  takePreviewAgentDialogRecords,
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
    dispatchEvent: target.dispatchEvent.bind(target),
    CustomEvent,
  };
  runInNewContext(`(${installPreviewAgentDialogPolicy.toString()})("dialog", "answer", 1024)`, main);
  runInNewContext(`(${installPreviewAgentDialogRecorder.toString()})("dialog", 1024, 20)`, isolated);
  const state = () => isolated.__inertiaAgentDialogs as {
    records: Array<PreviewAgentDialog & { truncated: boolean }>;
    omitted: number;
  };
  const records = (): PreviewAgentDialog[] => state().records.map(({ kind, message, answer }) => ({ kind, message, answer }));
  const arm = (answer: string): void => {
    runInNewContext(`(${armPreviewAgentDialogAnswer.toString()})("answer", ${JSON.stringify(answer)})`, isolated);
  };
  const take = () => runInNewContext(`(${takePreviewAgentDialogRecords.toString()})(20)`, isolated) as {
    records: PreviewAgentDialog[];
    omitted: number;
  };
  return { main, state, records, arm, take, target };
}

describe("Browser dialog policy", () => {
  it("answers without a native dialog and records each call for the agent", () => {
    const { main, records, arm } = page();
    expect(runInNewContext("alert('Saved')", main)).toBeUndefined();
    expect(runInNewContext("confirm('Delete?')", main)).toBe(false);
    expect(runInNewContext("prompt('Name?')", main)).toBeNull();
    arm("accept");
    expect(runInNewContext("prompt('Name?')", main)).toBeNull();
    expect(runInNewContext("confirm('Really delete?')", main)).toBe(true);
    expect(runInNewContext("confirm({ toString() { return 'Object message'; } })", main)).toBe(false);
    expect(records()).toEqual([
      { kind: "alert", message: "Saved", answer: "accept" },
      { kind: "confirm", message: "Delete?", answer: "dismiss" },
      { kind: "prompt", message: "Name?", answer: "dismiss" },
      { kind: "prompt", message: "Name?", answer: "dismiss" },
      { kind: "confirm", message: "Really delete?", answer: "accept" },
      { kind: "confirm", message: "Object message", answer: "dismiss" },
    ]);
  });

  it("accepts only the first confirmation after one arming", () => {
    const { main, records, arm } = page();
    arm("accept");
    expect(runInNewContext("[confirm('First?'), confirm('Second?')]", main)).toEqual([true, false]);
    arm("accept");
    arm("dismiss");
    expect(runInNewContext("confirm('Third?')", main)).toBe(false);
    expect(records().map(({ answer }) => answer)).toEqual(["accept", "dismiss", "dismiss"]);
  });

  it("bounds each message and each report, and starts a new report after it is taken", () => {
    const { main, state, records, take } = page();
    runInNewContext("alert('x'.repeat(5000)); alert('short')", main);
    expect(records()[0]!.message).toHaveLength(1_024);
    expect(state().records.slice(0, 2).map(({ truncated }) => truncated)).toEqual([true, false]);
    runInNewContext("for (let index = 0; index < 23; index += 1) alert(String(index))", main);
    const first = take();
    expect(first.records).toHaveLength(20);
    expect(first.omitted).toBe(5);
    runInNewContext("alert('after')", main);
    expect(take()).toEqual({
      records: [{ kind: "alert", message: "after", answer: "accept", truncated: false }],
      omitted: 0,
    });
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

  it("never takes an answer from the page and ignores malformed records", () => {
    const { records, target } = page();
    for (const detail of [
      JSON.stringify(["confirm", "Forged", "accept", false]),
      JSON.stringify(["eval", "x", false]),
      JSON.stringify(["alert", "x".repeat(1_025), false]),
      JSON.stringify(["alert", 1, false]),
      "not json",
      42,
    ]) target.dispatchEvent(new CustomEvent("dialog", { detail }));
    target.dispatchEvent(new CustomEvent("dialog", { detail: JSON.stringify(["confirm", "Forged", false]) }));
    expect(records()).toEqual([{ kind: "confirm", message: "Forged", answer: "dismiss" }]);
  });
});
