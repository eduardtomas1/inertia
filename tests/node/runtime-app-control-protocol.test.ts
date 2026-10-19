import { describe, expect, it } from "vitest";

import {
  APP_CONTROL_MAX_ELEMENTS,
  APP_CONTROL_MAX_PAYLOAD_BYTES,
  parseAppControlCommand,
  parseAppControlResult,
  parseRuntimeAppControlEvent,
  parseRuntimeAppControlResult,
  sameAppControlIdentity,
} from "../../src/node/runtime-app-control-protocol";
import { parseRuntimeWorkerCommand, parseRuntimeWorkerEvent } from "../../src/node/runtime-process-protocol";

const identity = {
  conversationId: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
  turnId: "33333333-3333-4333-8333-333333333333",
  launchId: "44444444-4444-4444-8444-444444444444",
  pid: 4_321,
  processStartedAt: 1_760_000_000_000,
};
const requestId = "55555555-5555-4555-8555-555555555555";
const token = "a".repeat(32);
const element = {
  token: "b".repeat(32), role: "button", name: "Save", value: null, enabled: true, focused: false, checked: null,
  expanded: null, editable: false, sensitive: false, offscreen: false, rect: { x: 1, y: 2, width: 30, height: 20 }, actions: ["press"],
};
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 24 }, () => 0)]);

describe("runtime App control protocol", () => {
  it("accepts every command with exact keys and worker-minted tokens", () => {
    for (const command of [
      { command: "windows" },
      { command: "permissions" },
      { command: "snapshot", window: token },
      { command: "screenshot", window: token },
      { command: "inspect", window: token, element: null },
      { command: "inspect", window: token, element: token },
      { command: "perform", window: token, element: token, action: "press", text: null, expect: null },
      { command: "perform", window: token, element: null, action: "press", text: null, expect: null },
      { command: "perform", window: token, element: null, action: "activate", text: null, expect: null },
      { command: "perform", window: token, element: token, action: "setValue", text: "hello", expect: { rootKey: token, role: "text_field", name: "Name" } },
      { command: "perform", window: token, element: token, action: "typeText", text: "", expect: null },
      { command: "perform", window: token, element: token, action: "scrollIntoView", text: null, expect: null },
    ]) {
      expect(parseAppControlCommand(command), JSON.stringify(command)).toEqual(command);
    }
  });

  it.each([
    [{ command: "windows", extra: true }],
    [{ command: "snapshot", window: "A".repeat(32) }],
    [{ command: "snapshot", window: token.slice(1) }],
    [{ command: "inspect", window: token }],
    [{ command: "perform", window: token, element: null, action: "setValue", text: "x", expect: null }],
    [{ command: "perform", window: token, element: null, action: "toggle", text: null, expect: null }],
    [{ command: "perform", window: token, element: token, action: "setValue", text: null, expect: null }],
    [{ command: "perform", window: token, element: token, action: "press", text: "x", expect: null }],
    [{ command: "perform", window: token, element: token, action: "typeText", text: "a\u0000b", expect: null }],
    [{ command: "perform", window: token, element: token, action: "typeText", text: "\u{1F600}".repeat(4_001), expect: null }],
    [{ command: "perform", window: token, element: token, action: "drag", text: null, expect: null }],
    // Closing a window is not an App control action.
    [{ command: "perform", window: token, element: null, action: "close", text: null, expect: null }],
    [{ command: "perform", window: token, element: token, action: "close", text: null, expect: null }],
    [{ command: "perform", window: token, element: token, action: "press", text: null, expect: { rootKey: token, role: "button" } }],
    [{ command: "perform", window: token, element: token, action: "press", text: null }],
    [{ command: "type", text: "x" }],
    [null],
    [[{ command: "windows" }]],
  ])("refuses the malformed command %j", (command) => {
    expect(parseAppControlCommand(command)).toBeNull();
  });

  it("binds every request to the full launch identity and refuses turnless writes", () => {
    const request = { type: "runtime.app-control-request", requestId, identity, command: { command: "snapshot", window: token } };
    expect(parseRuntimeAppControlEvent(request)).toEqual(request);
    expect(parseRuntimeWorkerEvent(request)).toEqual(request);
    const background = { ...identity, runId: null, turnId: null };
    expect(parseRuntimeAppControlEvent({ ...request, identity: background, command: { command: "windows" } }))
      .toMatchObject({ command: { command: "windows" } });
    // An agent's window listing carries its turn across the boundary unchanged.
    expect(parseRuntimeWorkerEvent({ ...request, command: { command: "windows" } }))
      .toEqual({ ...request, identity, command: { command: "windows" } });
    // Without a turn only window listing and permission reads are accepted.
    expect(parseRuntimeAppControlEvent({ ...request, identity: background })).toMatchObject({ command: null });
    for (const broken of [
      { ...identity, runId: null },
      { ...identity, pid: 1 },
      { ...identity, pid: 1.5 },
      { ...identity, processStartedAt: 0 },
      { ...identity, launchId: "launch" },
      { ...identity, extra: true },
      (({ processStartedAt: _omitted, ...rest }) => rest)(identity),
    ]) {
      expect(parseRuntimeAppControlEvent({ ...request, identity: broken }), JSON.stringify(broken)).toBeNull();
    }
    expect(parseRuntimeAppControlEvent({ ...request, requestId: "not-a-uuid" })).toBeNull();
    expect(parseRuntimeAppControlEvent({ ...request, extra: 1 })).toBeNull();
    // A request whose command is malformed is still answered, as invalid.
    expect(parseRuntimeAppControlEvent({ ...request, command: { command: "shell" } })).toMatchObject({ command: null });
    const cancel = { type: "runtime.app-control-cancel", requestId, identity };
    expect(parseRuntimeAppControlEvent(cancel)).toEqual(cancel);
    expect(parseRuntimeAppControlEvent({ ...cancel, command: { command: "windows" } })).toBeNull();
  });

  it("compares identities field by field", () => {
    expect(sameAppControlIdentity(identity, { ...identity })).toBe(true);
    for (const key of Object.keys(identity) as (keyof typeof identity)[]) {
      const other = { ...identity, [key]: typeof identity[key] === "number" ? (identity[key] as number) + 1 : "66666666-6666-4666-8666-666666666666" };
      expect(sameAppControlIdentity(identity, other), key).toBe(false);
    }
  });

  it("validates results strictly, including the kind each command answers", () => {
    const windows = { ok: true, value: { kind: "windows", windows: [
      { token, pid: 10, title: "Main", active: true, denied: false, bounds: { x: 0, y: 0, width: 800, height: 600 } },
      { token: null, pid: 11, title: "", active: false, denied: true, bounds: null },
    ], omitted: 2 } };
    expect(parseAppControlResult(windows, "windows")).toEqual(windows);
    // The omitted count is required and bounded.
    expect(parseAppControlResult({ ok: true, value: { kind: "windows", windows: [] } })).toBeNull();
    expect(parseAppControlResult({ ok: true, value: { kind: "windows", windows: [], omitted: -1 } })).toBeNull();
    for (const reason of ["tree-too-large", "start-failed", "empty-tree"]) {
      expect(parseAppControlResult({ ok: false, code: "unavailable", reason, dispatched: false })).toMatchObject({ reason });
    }
    expect(parseAppControlResult(windows, "snapshot")).toBeNull();
    // A denied window can never carry an addressable token.
    expect(parseAppControlResult({ ok: true, value: { kind: "windows", windows: [{ ...windows.value.windows[1], token }], omitted: 0 } })).toBeNull();
    const snapshot = {
      ok: true,
      value: {
        kind: "snapshot", rootKey: token, title: "Main", bounds: null, text: "Hello", elements: [element],
        omittedTextChars: 0, omittedElements: 0, readLimitReached: false, unlabelled: false, sensitiveFilled: false,
      },
    };
    expect(parseAppControlResult(snapshot, "snapshot")).toEqual(snapshot);
    // A sensitive control never crosses with its value.
    expect(parseAppControlResult({ ...snapshot, value: { ...snapshot.value, elements: [{ ...element, sensitive: true, value: "hunter2" }] } })).toBeNull();
    expect(parseAppControlResult({ ...snapshot, value: { ...snapshot.value, elements: [{ ...element, sensitive: true, value: "[redacted]" }] } })).not.toBeNull();
    expect(parseAppControlResult({ ...snapshot, value: { ...snapshot.value, elements: Array.from({ length: APP_CONTROL_MAX_ELEMENTS + 1 }, () => element) } })).toBeNull();
    expect(parseAppControlResult({ ...snapshot, value: { ...snapshot.value, extra: 1 } })).toBeNull();
    expect(parseAppControlResult({ ...snapshot, value: { ...snapshot.value, elements: [{ ...element, actions: ["Press me"] }] } })).toBeNull();
    expect(parseAppControlResult({ ...snapshot, value: { ...snapshot.value, elements: [{ ...element, rect: { x: Number.NaN, y: 0, width: 1, height: 1 } }] } })).toBeNull();
    const failure = { ok: false, code: "permission-denied", reason: "screen-recording", dispatched: false };
    expect(parseAppControlResult(failure)).toEqual(failure);
    expect(parseAppControlResult({ ...failure, message: "native text" })).toBeNull();
    expect(parseAppControlResult({ ...failure, code: "crashed" })).toBeNull();
    expect(parseAppControlResult({ ok: true, value: { kind: "perform", rootKey: null, windowClosed: true } }, "perform")).not.toBeNull();
    expect(parseAppControlResult({ ok: true, value: { kind: "screenshot", width: 10, height: 10, png, mayIncludeOverlappingWindows: true } }, "screenshot")).not.toBeNull();
    expect(parseAppControlResult({ ok: true, value: { kind: "screenshot", width: 10, height: 10, png: new Uint8Array(40), mayIncludeOverlappingWindows: true } })).toBeNull();
  });

  it("bounds every payload at 24 KiB, apart from the bounded thumbnail bytes", () => {
    const text = "x".repeat(12_000);
    const elements = Array.from({ length: APP_CONTROL_MAX_ELEMENTS }, () => ({ ...element, name: "n".repeat(300) }));
    const large = { ok: true, value: {
      kind: "snapshot", rootKey: token, title: "Main", bounds: null, text, elements,
      omittedTextChars: 0, omittedElements: 0, readLimitReached: false, unlabelled: false, sensitiveFilled: false,
    } };
    expect(JSON.stringify(large).length).toBeGreaterThan(APP_CONTROL_MAX_PAYLOAD_BYTES);
    expect(parseAppControlResult(large)).toBeNull();
    const shot = { ok: true, value: { kind: "screenshot", width: 10, height: 10, png: new Uint8Array([...png, ...new Uint8Array(200_000)]), mayIncludeOverlappingWindows: false } };
    expect(parseAppControlResult(shot)).not.toBeNull();
    expect(parseAppControlResult({ ok: true, value: { ...shot.value, png: new Uint8Array([...png, ...new Uint8Array(300_000)]) } })).toBeNull();
  });

  it("carries results to the runtime only with a UUID request id", () => {
    const result = { type: "runtime.app-control-result", requestId, result: { ok: false, code: "timeout", reason: null, dispatched: true } };
    expect(parseRuntimeAppControlResult(result)).toEqual(result);
    expect(parseRuntimeWorkerCommand(result)).toEqual(result);
    expect(parseRuntimeAppControlResult({ ...result, requestId: "1" })).toBeNull();
    expect(parseRuntimeAppControlResult({ ...result, extra: 1 })).toBeNull();
  });
});
