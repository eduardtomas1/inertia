import { describe, expect, it, vi } from "vitest";

import type { ProviderHostToolCall } from "../../src/server/provider/contracts";
import { ProviderHostToolRuntime } from "../../src/server/provider/host-tool-runtime";
import type { AgentApprovalDecision } from "../../src/server/provider/interactions";
import { APP_UNDER_TEST_TOOL_DEFINITIONS, AppUnderTestHostTools } from "../../src/server/runtime/app-under-test/host-tools";
import {
  AppProgressGuard,
  appCallKey,
  appSnapshotFingerprint,
} from "../../src/server/runtime/app-under-test/progress-guard";
import type {
  AppUnderTestAgentImage,
  AppUnderTestDestructiveWindowCommand,
  AppUnderTestInputRoute,
  AppUnderTestWindowCommand,
  AppUnderTestWindowInspectionResult,
  AppUnderTestWindowPerformOptions,
  AppUnderTestWindowResult,
} from "../../src/server/runtime/app-under-test/window-transport";
import { APP_AGENT_IMAGE_NOTE, APP_AGENT_IMAGE_OVERLAP_NOTE, type AppUnderTestLaunch } from "../../src/shared/app-under-test";
import { ACCESSIBILITY_MESSAGES } from "../../src/server/runtime/app-under-test/accessibility-window-support";
import type { Conversation } from "../../src/shared/contracts";

/**
 * Phase 3 of the App pack at the host-tool boundary: model-visible
 * screenshots, activation and synthesized input approvals, and the
 * per-turn progress guard. The launch manager and transport are fakes.
 */

const conversationId = "11111111-1111-4111-8111-111111111111";
const launchId = "22222222-2222-4222-8222-222222222222";
const windowId = "33333333-3333-4333-8333-333333333333";
const turnId = "66666666-6666-4666-8666-666666666666";
const identity = { conversationId, runId: "55555555-5555-4555-8555-555555555555", turnId, remoteDevice: false };
const visual = { ...identity, visualEvidence: true, imagesAccepted: true };
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(bytes = 64): Uint8Array {
  const value = new Uint8Array(bytes);
  value.set(PNG_HEADER);
  return value;
}

function conversation(accessMode: Conversation["accessMode"] = "full"): Conversation {
  return { id: conversationId, accessMode } as Conversation;
}

function call(tool: string, args: unknown, decision: AgentApprovalDecision = "approve"): ProviderHostToolCall & { requestApproval: ReturnType<typeof vi.fn> } {
  return {
    providerThreadId: "provider-thread",
    providerTurnId: "provider-turn",
    toolCallId: crypto.randomUUID(),
    tool,
    arguments: args,
    signal: new AbortController().signal,
    requestApproval: vi.fn(async () => decision),
  };
}

const launch: AppUnderTestLaunch = {
  launchId, conversationId, kind: "action", actionId: null, label: "Native app", startedBy: "agent",
  state: "running", pid: 4_321, startedAt: "2026-10-19T10:00:00.000Z", readyAt: null, exitedAt: null,
  exitCode: null, signal: null, stopRequested: false, cdp: false, transport: "accessibility", windowCount: 1, windows: [],
  cleanupConfirmed: null, failure: null,
};

function harness(options: { route?: (command: AppUnderTestDestructiveWindowCommand) => AppUnderTestInputRoute; native?: boolean } = {}) {
  const state = {
    image: { png: png(), width: 1_200, height: 600 } as AppUnderTestAgentImage | null,
    /** A region capture (Windows, X11), which never reaches the model. */
    overlapping: false,
    screenshotFailure: null as AppUnderTestWindowResult | null,
    performFailure: null as AppUnderTestWindowResult | null,
    elements: [{ ref: "e1", role: "button", name: "Save" }] as unknown[],
    text: "Welcome",
    viewport: { width: 640, height: 400 },
    documentSequence: 1,
    activated: true,
  };
  const performed: AppUnderTestWindowCommand[] = [];
  const transport = {
    windows: vi.fn(() => []),
    pendingDialog: vi.fn(() => null),
    redactLog: vi.fn((text: string) => text),
    inspect: vi.fn(async (command: AppUnderTestDestructiveWindowCommand): Promise<AppUnderTestWindowInspectionResult> => ({
      ok: true,
      inspection: {
        windowId, windowNumber: 2, documentSequence: state.documentSequence,
        target: command.action === "activate" ? null : { role: "text_field", label: "Notes", sensitive: false },
        dialog: null,
        ...(options.route?.(command) === "synthesized" ? { synthesized: true } : {}),
      },
    })),
    perform: vi.fn(async (command: AppUnderTestWindowCommand, _options?: AppUnderTestWindowPerformOptions): Promise<AppUnderTestWindowResult> => {
      performed.push(command);
      if (command.action === "screenshot") {
        if (state.screenshotFailure) return state.screenshotFailure;
        const overlap = state.overlapping ? { mayIncludeOverlappingWindows: true } : {};
        // As the real transports do: a model-visible request leaves its evidence to the host tool.
        return command.agentImage
          ? { ok: true, value: { captured: true, width: 640, height: 400, ...overlap }, image: state.image, thumbnail: { png: png(), width: 320, height: 200 } }
          : { ok: true, value: { captured: true, evidenceId: "77777777-7777-4777-8777-777777777777", width: 640, height: 400, ...overlap } };
      }
      if (command.action === "snapshot") return { ok: true, value: { title: "Main", elements: state.elements, text: state.text, viewport: state.viewport } };
      if (state.performFailure) return state.performFailure;
      if (command.action === "activate") return { ok: true, value: { activated: state.activated } };
      return { ok: true, value: { performed: command.action } };
    }),
    waitForWindow: vi.fn(async () => true),
    close: vi.fn(),
    documentSequence: vi.fn(() => state.documentSequence),
    ...(options.route ? { inputRoute: vi.fn((command: AppUnderTestDestructiveWindowCommand) => options.route!(command)) } : {}),
  };
  const manager = {
    status: vi.fn(() => [launch]),
    windowOwner: vi.fn(() => ({ launch, transport })),
    hasWindowTransport: vi.fn(() => true),
    withAction: vi.fn(async (_conversationId: string, _launchId: string, operation: () => Promise<unknown>) => await operation()),
    appendEvidence: vi.fn((_conversationId: string, _launchId: string, input: { kind: string }) => (
      input.kind === "screenshot" ? { evidenceId: "77777777-7777-4777-8777-777777777777" } : { evidenceId: "99999999-9999-4999-8999-999999999999" }
    )),
    turnSettled: vi.fn(),
  };
  const tools = new AppUnderTestHostTools(manager as never);
  return { state, transport, manager, tools, performed };
}

function parsed(result: { text: string }): Record<string, unknown> {
  return JSON.parse(result.text) as Record<string, unknown>;
}

const nativeRoute = (command: AppUnderTestDestructiveWindowCommand): AppUnderTestInputRoute => (
  (command.action === "press" && command.key !== "Enter" && command.key !== "Space")
  || (command.action === "scroll" && "deltaY" in command)
    ? "synthesized"
    : "accessibility"
);

describe("model-visible App screenshots", () => {
  it("send one bounded PNG only when the project opted in and the route accepts images", async () => {
    const { tools, performed } = harness();
    const shot = () => call("inertia_app_screenshot", { windowId });

    const off = await tools.invoke(conversation(), shot(), identity);
    expect(off.images).toBeUndefined();
    expect(parsed(off)).toMatchObject({ captured: true, sentToAgent: false, note: "local evidence only" });
    expect(performed.at(-1)).toEqual({ action: "screenshot", windowId });

    const textOnly = await tools.invoke(conversation(), shot(), { ...identity, visualEvidence: true, imagesAccepted: false });
    expect(textOnly.images).toBeUndefined();
    expect(parsed(textOnly)).toMatchObject({ sentToAgent: false, note: expect.stringContaining("does not accept images") });
    expect(performed.at(-1)).toEqual({ action: "screenshot", windowId });
    // The route alone is not consent.
    expect((await tools.invoke(conversation(), shot(), { ...identity, imagesAccepted: true })).images).toBeUndefined();

    const sent = await tools.invoke(conversation(), shot(), visual);
    expect(performed.at(-1)).toEqual({ action: "screenshot", windowId, agentImage: true });
    expect(sent.images).toEqual([{ mimeType: "image/png", data: Buffer.from(png()).toString("base64") }]);
    expect(parsed(sent)).toEqual({
      captured: true, evidenceId: "77777777-7777-4777-8777-777777777777", width: 640, height: 400,
      windowId, launchId, sentToAgent: true, imageWidth: 1_200, imageHeight: 600, note: APP_AGENT_IMAGE_NOTE,
    });
    expect(APP_AGENT_IMAGE_NOTE).toBe("Coordinates from this image are not accepted by any tool; use refs from a snapshot.");
  });

  it("checks the image bounds again and keeps an oversized or malformed one local", async () => {
    const { state, tools } = harness();
    const oversized = new Uint8Array(3_750_001);
    oversized.set(PNG_HEADER);
    for (const image of [
      { png: png(), width: 1_537, height: 400 },
      { png: png(), width: 400, height: 1_537 },
      { png: png(), width: 1_201, height: 600 },
      { png: oversized, width: 800, height: 600 },
      { png: new Uint8Array(64), width: 800, height: 600 },
      { png: png(), width: 0, height: 600 },
      null,
    ]) {
      state.image = image;
      const result = await tools.invoke(conversation(), call("inertia_app_screenshot", { windowId }), visual);
      expect(result.images, JSON.stringify(image && { width: image.width, height: image.height })).toBeUndefined();
      expect(parsed(result)).toMatchObject({ sentToAgent: false, note: expect.stringContaining("local evidence only") });
    }
    // A result whose image does not count does not use the turn's allowance.
    state.image = { png: png(), width: 1_536, height: 468 };
    for (let index = 0; index < 8; index += 1) {
      expect((await tools.invoke(conversation(), call("inertia_app_screenshot", { windowId }), visual)).images).toHaveLength(1);
    }
  });

  it("pass through the privacy gate's refusal without using the allowance", async () => {
    const { state, tools } = harness();
    state.screenshotFailure = {
      ok: false, code: "sensitive", message: "Screenshots are unavailable while this window holds a secret value.", dispatched: false,
    };
    const refused = await tools.invoke(conversation(), call("inertia_app_screenshot", { windowId }), visual);
    expect(refused.images).toBeUndefined();
    expect(parsed(refused)).toEqual({
      error: { code: "sensitive", message: expect.stringContaining("secret"), retryable: false, dispatched: false },
    });
    state.screenshotFailure = null;
    for (let index = 0; index < 8; index += 1) {
      expect((await tools.invoke(conversation(), call("inertia_app_screenshot", { windowId }), visual)).images).toHaveLength(1);
    }
  });

  it("send at most eight per turn, then refuse with screenshot_limit_reached until the next turn", async () => {
    const { tools, manager, performed } = harness();
    for (let index = 0; index < 8; index += 1) {
      expect((await tools.invoke(conversation(), call("inertia_app_screenshot", { windowId }), visual)).images).toHaveLength(1);
    }
    const before = performed.length;
    const limited = await tools.invoke(conversation(), call("inertia_app_screenshot", { windowId }), visual);
    expect(parsed(limited)).toEqual({
      error: { code: "screenshot_limit_reached", message: expect.stringContaining("8 screenshots"), retryable: false, dispatched: false },
    });
    expect(performed).toHaveLength(before);
    // Local evidence stays available, and the limit is not a repeated failure.
    expect(parsed(await tools.invoke(conversation(), call("inertia_app_screenshot", { windowId }), identity))).toMatchObject({ sentToAgent: false });
    for (let index = 0; index < 3; index += 1) {
      expect(parsed(await tools.invoke(conversation(), call("inertia_app_screenshot", { windowId }), visual))).toMatchObject({ error: { code: "screenshot_limit_reached" } });
    }
    const next = { ...visual, turnId: "88888888-8888-4888-8888-888888888888" };
    expect((await tools.invoke(conversation(), call("inertia_app_screenshot", { windowId }), next)).images).toHaveLength(1);
    tools.turnSettled(turnId);
    expect(manager.turnSettled).toHaveBeenCalledWith(turnId);
    expect((await tools.invoke(conversation(), call("inertia_app_screenshot", { windowId }), visual)).images).toHaveLength(1);
  });

  it("never send a region capture that may include other windows, keeping it local without using the allowance", async () => {
    const { state, tools, manager } = harness();
    state.overlapping = true;
    for (let index = 0; index < 9; index += 1) {
      const result = await tools.invoke(conversation(), call("inertia_app_screenshot", { windowId }), visual);
      expect(result.images).toBeUndefined();
      expect(parsed(result)).toMatchObject({
        captured: true, evidenceId: "77777777-7777-4777-8777-777777777777", sentToAgent: false,
        mayIncludeOverlappingWindows: true, note: APP_AGENT_IMAGE_OVERLAP_NOTE,
      });
    }
    expect(APP_AGENT_IMAGE_OVERLAP_NOTE).toBe("local evidence only: on this platform the capture may include other windows, so it stays on this device.");
    expect(manager.appendEvidence.mock.calls.every(([, , input]) => !("sentToAgent" in input))).toBe(true);
    state.overlapping = false;
    expect((await tools.invoke(conversation(), call("inertia_app_screenshot", { windowId }), visual)).images).toHaveLength(1);
  });

  it("label the evidence as sent only once the image was validated and attached", async () => {
    const { state, tools, manager } = harness();
    const shots = () => manager.appendEvidence.mock.calls.filter(([, , input]) => input.kind === "screenshot").map(([, , input]) => input);
    const sent = await tools.invoke(conversation(), call("inertia_app_screenshot", { windowId }), visual);
    expect(sent.images).toHaveLength(1);
    expect(shots().at(-1)).toEqual({ kind: "screenshot", png: png(), width: 320, height: 200, sentToAgent: true });
    // An image that fails the boundary check, or none at all, is recorded as an ordinary screenshot.
    for (const image of [{ png: png(), width: 1_537, height: 100 }, null]) {
      state.image = image;
      const kept = await tools.invoke(conversation(), call("inertia_app_screenshot", { windowId }), visual);
      expect(parsed(kept)).toMatchObject({ sentToAgent: false, evidenceId: "77777777-7777-4777-8777-777777777777" });
      expect(shots().at(-1)).toEqual({ kind: "screenshot", png: png(), width: 320, height: 200 });
    }
    // Evidence that cannot be kept fails the screenshot instead of returning an image without a record.
    state.image = { png: png(), width: 1_200, height: 600 };
    manager.appendEvidence.mockReturnValueOnce(null as never);
    const lost = await tools.invoke(conversation(), call("inertia_app_screenshot", { windowId }), visual);
    expect(lost.images).toBeUndefined();
    expect(parsed(lost)).toMatchObject({ error: { code: "unavailable", message: expect.stringContaining("local evidence") } });
  });

  it("reach the model through the host-tool runtime's image bounds", async () => {
    const { tools } = harness();
    const runtime = new ProviderHostToolRuntime({
      bridge: {
        definitions: APP_UNDER_TEST_TOOL_DEFINITIONS,
        invoke: async (toolCall) => await tools.invoke(conversation(), toolCall, visual),
      },
      conversationId: "thread", turnId: "turn", cwd: "/project",
      onApproval: () => undefined, onApprovalResolved: () => undefined,
    });
    const result = await runtime.invoke({ callId: "call-1", tool: "inertia_app_screenshot", arguments: { windowId } });
    expect(result.images).toEqual([{ mimeType: "image/png", data: Buffer.from(png()).toString("base64") }]);
    expect(JSON.parse(result.text)).toMatchObject({ sentToAgent: true });
  });
});

describe("activation and synthesized input approvals", () => {
  it("asks to bring a window to the front in every access mode, with fixed wording", async () => {
    for (const mode of ["supervised", "auto-edit", "full"] as const) {
      const { tools, performed, manager } = harness({ route: nativeRoute });
      const activate = call("inertia_app_activate", { windowId });
      const result = await tools.invoke(conversation(mode), activate, identity);
      expect(result.success, mode).toBe(true);
      expect(activate.requestApproval, mode).toHaveBeenCalledOnce();
      expect(activate.requestApproval.mock.calls[0]![0]).toMatchObject({
        title: "Bring the app window to the front",
        detail: "App window 2\nBring this window to the front and give it keyboard focus. For the rest of this turn the agent may send it keys and mouse-wheel scrolling, each asked for separately unless the chat has Full Access.",
      });
      expect(performed.at(-1)).toEqual({ action: "activate", windowId });
      expect(manager.appendEvidence).toHaveBeenCalledWith(conversationId, launchId, { kind: "action", action: "activate" });
      const denied = call("inertia_app_activate", { windowId }, "deny");
      expect(parsed(await tools.invoke(conversation(mode), denied, identity))).toMatchObject({ error: { code: "user_denied" } });
    }
  });

  it("asks for synthesized keys and wheel input in Supervised and Auto-edit, never in Full Access", async () => {
    const matrix: Array<[string, Record<string, unknown>, string, boolean]> = [];
    for (const mode of ["supervised", "auto-edit", "full"] as const) {
      const { tools } = harness({ route: nativeRoute });
      for (const [tool, args] of [
        ["inertia_app_press", { windowId, key: "Tab" }],
        ["inertia_app_scroll", { windowId, deltaY: 300 }],
        ["inertia_app_press", { windowId, key: "Enter" }],
        ["inertia_app_click", { windowId, ref: "e1" }],
      ] as const) {
        const request = call(tool, args);
        expect((await tools.invoke(conversation(mode), request, identity)).success, `${mode} ${tool}`).toBe(true);
        matrix.push([mode, args, tool, request.requestApproval.mock.calls.length === 1]);
      }
    }
    expect(matrix.map(([mode, args, tool, asked]) => `${mode} ${tool} ${JSON.stringify(args.key ?? args.deltaY ?? args.ref)} ${asked ? "asks" : "runs"}`)).toEqual([
      "supervised inertia_app_press \"Tab\" asks",
      "supervised inertia_app_scroll 300 asks",
      "supervised inertia_app_press \"Enter\" asks",
      "supervised inertia_app_click \"e1\" asks",
      "auto-edit inertia_app_press \"Tab\" asks",
      "auto-edit inertia_app_scroll 300 asks",
      "auto-edit inertia_app_press \"Enter\" runs",
      "auto-edit inertia_app_click \"e1\" runs",
      "full inertia_app_press \"Tab\" runs",
      "full inertia_app_scroll 300 runs",
      "full inertia_app_press \"Enter\" runs",
      "full inertia_app_click \"e1\" runs",
    ]);
  });

  it("says on the card that the input is sent to the window, and binds the approval to the synthesized route", async () => {
    const { tools, transport } = harness({ route: nativeRoute });
    const press = call("inertia_app_press", { windowId, key: "Tab" });
    await tools.invoke(conversation("auto-edit"), press, identity);
    expect(press.requestApproval.mock.calls[0]![0]).toMatchObject({
      title: "Press", detail: "App window 2\nPress: Tab on text_field: Notes\nThis sends keyboard input to the app window.",
    });
    expect(transport.perform.mock.calls.at(-1)![1]).toMatchObject({ expected: { documentSequence: 1, synthesized: true } });
    const scroll = call("inertia_app_scroll", { windowId, deltaY: -120 });
    await tools.invoke(conversation("supervised"), scroll, identity);
    expect(scroll.requestApproval.mock.calls[0]![0]).toMatchObject({
      title: "Scroll", detail: "App window 2\nScroll up: 120 pixels as 1 wheel notch\nThis scrolls the app window with the mouse wheel at its centre.",
    });
    // The planned route travels with the call, so the transport can refuse if it changed meanwhile.
    expect(transport.perform.mock.calls.at(-1)![1]).toMatchObject({ route: "synthesized", expected: { synthesized: true } });
    const wheel = call("inertia_app_scroll", { windowId, deltaY: 2_960 });
    await tools.invoke(conversation("supervised"), wheel, identity);
    expect(wheel.requestApproval.mock.calls[0]![0]).toMatchObject({ detail: expect.stringContaining("Scroll down: 2960 pixels as 30 wheel notches") });
    const enter = call("inertia_app_press", { windowId, key: "Enter" });
    await tools.invoke(conversation("full"), enter, identity);
    expect(transport.perform.mock.calls.at(-1)![1]).toMatchObject({ route: "accessibility" });
    expect(transport.perform.mock.calls.at(-1)![1]).not.toHaveProperty("expected");
    // Electron windows have no input route: their input stays Supervised-only.
    const electron = harness();
    const pipe = call("inertia_app_press", { windowId, key: "Tab" });
    await electron.tools.invoke(conversation("auto-edit"), pipe, identity);
    expect(pipe.requestApproval).not.toHaveBeenCalled();
    expect(electron.transport.perform.mock.calls.at(-1)![1]).not.toHaveProperty("route");
  });
});

describe("App progress guard", () => {
  it("refuses an identical call after three failures in a row, per turn and per argument", async () => {
    const { state, tools, transport } = harness();
    state.performFailure = { ok: false, code: "invalid", message: "That control is disabled.", dispatched: false };
    const click = { windowId, ref: "e1" };
    for (let index = 0; index < 3; index += 1) {
      expect(parsed(await tools.invoke(conversation(), call("inertia_app_click", click), identity))).toMatchObject({ error: { code: "invalid" } });
    }
    const sent = transport.perform.mock.calls.length;
    const repeated = await tools.invoke(conversation(), call("inertia_app_click", click), identity);
    expect(parsed(repeated)).toEqual({ error: {
      code: "repeated_failure",
      message: "The same action failed three times. Take a new snapshot, change the approach, or ask the user.",
      retryable: false,
      dispatched: false,
    } });
    expect(transport.perform.mock.calls).toHaveLength(sent);
    // Key order does not make a call different; another ref or another turn does.
    expect(parsed(await tools.invoke(conversation(), call("inertia_app_click", { ref: "e1", windowId }), identity))).toMatchObject({ error: { code: "repeated_failure" } });
    expect(parsed(await tools.invoke(conversation(), call("inertia_app_click", { windowId, ref: "e2" }), identity))).toMatchObject({ error: { code: "invalid" } });
    expect(parsed(await tools.invoke(conversation(), call("inertia_app_click", click), { ...identity, turnId: "99999999-9999-4999-8999-999999999999" })))
      .toMatchObject({ error: { code: "invalid" } });
    tools.turnSettled(turnId);
    state.performFailure = null;
    expect((await tools.invoke(conversation(), call("inertia_app_click", click), identity)).success).toBe(true);
  });

  it("does not count refusals and cancellations, and a success starts the count again", async () => {
    const { state, tools } = harness();
    const click = { windowId, ref: "e1" };
    for (let index = 0; index < 4; index += 1) {
      expect(parsed(await tools.invoke(conversation("supervised"), call("inertia_app_click", click, "deny"), identity))).toMatchObject({ error: { code: "user_denied" } });
    }
    state.performFailure = { ok: false, code: "timeout", message: "The window did not answer in time.", dispatched: false };
    await tools.invoke(conversation(), call("inertia_app_click", click), identity);
    await tools.invoke(conversation(), call("inertia_app_click", click), identity);
    state.performFailure = null;
    expect((await tools.invoke(conversation(), call("inertia_app_click", click), identity)).success).toBe(true);
    state.performFailure = { ok: false, code: "timeout", message: "The window did not answer in time.", dispatched: false };
    await tools.invoke(conversation(), call("inertia_app_click", click), identity);
    await tools.invoke(conversation(), call("inertia_app_click", click), identity);
    expect(parsed(await tools.invoke(conversation(), call("inertia_app_click", click), identity))).toMatchObject({ error: { code: "timeout" } });
    expect(parsed(await tools.invoke(conversation(), call("inertia_app_click", click), identity))).toMatchObject({ error: { code: "repeated_failure" } });
  });

  it("refuses the next input after three dispatched inputs whose follow-up snapshot showed no change", async () => {
    const { state, tools, transport } = harness();
    const snapshot = async () => await tools.invoke(conversation(), call("inertia_app_snapshot", { windowId }), identity);
    const click = async () => await tools.invoke(conversation(), call("inertia_app_click", { windowId, ref: "e1" }), identity);
    await snapshot();
    for (let index = 0; index < 3; index += 1) {
      expect((await click()).success).toBe(true);
      await snapshot();
    }
    const sent = transport.perform.mock.calls.length;
    expect(parsed(await click())).toEqual({ error: {
      code: "repeated_failure", message: expect.stringContaining("no visible change"), retryable: false, dispatched: false,
    } });
    expect(transport.perform.mock.calls).toHaveLength(sent);
    // It refuses once; the count starts again after it.
    expect((await click()).success).toBe(true);
    // A snapshot that changed (new elements or a new document) resets the count.
    await snapshot();
    expect((await click()).success).toBe(true);
    await snapshot();
    expect((await click()).success).toBe(true);
    state.elements = [{ ref: "e1", role: "button", name: "Saved" }];
    await snapshot();
    expect((await click()).success).toBe(true);
    await snapshot();
    expect((await click()).success).toBe(true);
    state.documentSequence = 2;
    await snapshot();
    expect((await click()).success).toBe(true);
  });

  it("keeps bounded state, evicts the least recently used turn and forgets a settled turn for good", () => {
    const guard = new AppProgressGuard();
    for (let index = 0; index < 32; index += 1) guard.recordOutcome(`turn-${index}`, "key", true);
    expect(guard.trackedTurns).toBe(32);
    // turn-0 is the oldest but was used again: the least recently used turn (turn-1) goes instead.
    for (let index = 0; index < 2; index += 1) guard.recordOutcome("turn-0", "key", true);
    guard.recordOutcome("turn-32", "key", true);
    expect(guard.trackedTurns).toBe(32);
    expect(guard.repeated("turn-0", "key")).toBe(true);
    for (let index = 0; index < 3; index += 1) guard.recordOutcome("turn-1", "key", true);
    expect(guard.repeated("turn-1", "key")).toBe(true);
    expect(guard.repeated("turn-2", "key")).toBe(false);
    for (let index = 0; index < 200; index += 1) guard.recordOutcome("turn-31", `key-${index}`, true);
    guard.settle("turn-31");
    expect(guard.trackedTurns).toBe(31);
    // A call that finishes after its turn settled leaves nothing behind.
    guard.recordOutcome("turn-31", "late", true);
    guard.recordAction("turn-31", windowId);
    guard.recordSnapshot("turn-31", windowId, "fingerprint");
    expect(guard.reserveScreenshot("turn-31")).toBe(true);
    expect(guard.trackedTurns).toBe(31);
    expect(appCallKey("inertia_app_click", { a: 1, b: 2 })).toBe(appCallKey("inertia_app_click", { b: 2, a: 1 }));
    expect(appCallKey("inertia_app_click", { a: 1 })).not.toBe(appCallKey("inertia_app_type", { a: 1 }));
    // Arguments are compared trimmed.
    expect(appCallKey("inertia_app_type", { windowId: ` ${windowId}`, ref: "e1 ", text: "hi\n" }))
      .toBe(appCallKey("inertia_app_type", { text: "hi", ref: "e1", windowId }));
    expect(appSnapshotFingerprint(1, { elements: [{ ref: "e1" }] })).not.toBe(appSnapshotFingerprint(2, { elements: [{ ref: "e1" }] }));
    // Text and viewport are part of what counts as a visible change.
    expect(appSnapshotFingerprint(1, { elements: [], text: "a" })).not.toBe(appSnapshotFingerprint(1, { elements: [], text: "b" }));
    expect(appSnapshotFingerprint(1, { elements: [], viewport: { width: 1 } })).not.toBe(appSnapshotFingerprint(1, { elements: [], viewport: { width: 2 } }));
  });

  it("does not count a wait that ran out of time or the not-in-front refusal as failures", async () => {
    const { state, tools } = harness({ route: nativeRoute });
    state.performFailure = { ok: false, code: "timeout", message: "The window did not answer in time.", dispatched: false };
    const wait = { windowId, text: "Saved", timeoutMs: 1_000 };
    for (let index = 0; index < 4; index += 1) {
      expect(parsed(await tools.invoke(conversation(), call("inertia_app_wait_for", wait), identity))).toMatchObject({ error: { code: "timeout" } });
    }
    state.performFailure = { ok: false, code: "unavailable", message: ACCESSIBILITY_MESSAGES.notInFront, dispatched: false };
    for (let index = 0; index < 4; index += 1) {
      expect(parsed(await tools.invoke(conversation(), call("inertia_app_press", { windowId, key: "Tab" }), identity))).toMatchObject({ error: { code: "unavailable" } });
    }
    // Other failures of the same call still count.
    state.performFailure = { ok: false, code: "unavailable", message: "Native window control is unavailable right now.", dispatched: false };
    for (let index = 0; index < 3; index += 1) await tools.invoke(conversation(), call("inertia_app_press", { windowId, key: "Tab" }), identity);
    expect(parsed(await tools.invoke(conversation(), call("inertia_app_press", { windowId, key: "Tab" }), identity))).toMatchObject({ error: { code: "repeated_failure" } });
  });

  it("clears a window's blocked calls after a successful activation or a snapshot that differs", async () => {
    const { state, tools } = harness({ route: nativeRoute });
    const press = () => call("inertia_app_press", { windowId, key: "Tab" });
    const block = async (): Promise<void> => {
      state.performFailure = { ok: false, code: "unavailable", message: "Native window control is unavailable right now.", dispatched: false };
      for (let index = 0; index < 3; index += 1) await tools.invoke(conversation(), press(), identity);
      state.performFailure = null;
      expect(parsed(await tools.invoke(conversation(), press(), identity))).toMatchObject({ error: { code: "repeated_failure" } });
    };
    await tools.invoke(conversation(), call("inertia_app_snapshot", { windowId }), identity);
    await block();
    // An activation the operating system did not honour changes nothing.
    state.activated = false;
    expect((await tools.invoke(conversation(), call("inertia_app_activate", { windowId }), identity)).success).toBe(true);
    expect(parsed(await tools.invoke(conversation(), press(), identity))).toMatchObject({ error: { code: "repeated_failure" } });
    state.activated = true;
    expect((await tools.invoke(conversation(), call("inertia_app_activate", { windowId }), identity)).success).toBe(true);
    expect((await tools.invoke(conversation(), press(), identity)).success).toBe(true);
    await block();
    // The same snapshot again changes nothing; a different one does.
    await tools.invoke(conversation(), call("inertia_app_snapshot", { windowId }), identity);
    expect(parsed(await tools.invoke(conversation(), press(), identity))).toMatchObject({ error: { code: "repeated_failure" } });
    state.text = "Saved";
    await tools.invoke(conversation(), call("inertia_app_snapshot", { windowId }), identity);
    expect((await tools.invoke(conversation(), press(), identity)).success).toBe(true);
  });

  it("applies the no-visible-change rule to click, type, press and scroll only, and counts text and viewport as a change", async () => {
    const { state, tools, manager } = harness({ route: nativeRoute });
    const snapshot = async () => await tools.invoke(conversation(), call("inertia_app_snapshot", { windowId }), identity);
    const click = async () => await tools.invoke(conversation(), call("inertia_app_click", { windowId, ref: "e1" }), identity);
    await snapshot();
    for (let index = 0; index < 3; index += 1) {
      await click();
      await snapshot();
    }
    // Activation, stop, status, logs and the window list neither trip nor spend the refusal.
    expect((await tools.invoke(conversation(), call("inertia_app_activate", { windowId }), identity)).success).toBe(true);
    expect((await tools.invoke(conversation(), call("inertia_app_status", {}), identity)).success).toBe(true);
    expect(parsed(await click())).toMatchObject({ error: { code: "repeated_failure", message: expect.stringContaining("no visible change") } });
    // A change only in the visible text, or only in the viewport, is a visible change.
    for (const change of [() => { state.text = "Saved"; }, () => { state.viewport = { width: 800, height: 400 }; }]) {
      for (let index = 0; index < 2; index += 1) {
        await click();
        await snapshot();
      }
      await click();
      change();
      await snapshot();
      expect((await click()).success).toBe(true);
      await snapshot();
    }
    expect(manager.appendEvidence).toHaveBeenCalledWith(conversationId, launchId, { kind: "action", action: "activate" });
  });
});
