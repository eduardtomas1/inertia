// @inertia-test-suite portable
import { afterEach, describe, expect, it, vi } from "vitest";

import { startCodexAppServerRun } from "../../src/server/codex-app-server";
import { ProviderManager } from "../../src/server/providers";
import {
  MAX_HISTORY_INJECTION_BYTES, type ProviderHistoryInjection, type ProviderHistoryResponseItem, type ProviderRunInput,
} from "../../src/server/provider/contracts";
import { removePortableFixture } from "../helpers/portable-provider-fixture";
import { captured, fakeAppServer } from "../helpers/codex-app-server-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

const INLINE_PROMPT = "Continue the plan\n\nStructured execution context: [restored history block]";
const NATIVE_PROMPT = "Continue the plan";

const historyItems: ProviderHistoryResponseItem[] = [
  { type: "message", role: "user", content: [{ type: "input_text", text: "Conversation context handoff from \"thread-1\"." }] },
  { type: "message", role: "user", content: [{ type: "input_text", text: "Historical item {\"id\":\"m-1\"}\nEarlier request" }] },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "Historical item {\"id\":\"m-2\"}\nEarlier answer" }] },
];

/** Exactly `bytes` JSON bytes of items: one context item padded with ASCII. */
function itemsOfBytes(bytes: number): ProviderHistoryResponseItem[] {
  const empty = [{ type: "message" as const, role: "user" as const, content: [{ type: "input_text" as const, text: "" }] }];
  const pad = bytes - Buffer.byteLength(JSON.stringify(empty));
  return [{ ...empty[0]!, content: [{ type: "input_text", text: "x".repeat(pad) }] }];
}

function recordingAuthority(options: { items?: ProviderHistoryResponseItem[]; begin?: boolean; delivered?: boolean } = {}) {
  const steps: string[] = [];
  const injection: ProviderHistoryInjection = {
    items: options.items ?? historyItems,
    prompt: NATIVE_PROMPT,
    begin: () => { steps.push("begin"); return options.begin ?? true; },
    delivered: () => { steps.push("delivered"); return options.delivered ?? true; },
    unsupported: () => { steps.push("unsupported"); return true; },
  };
  return { steps, injection };
}

type Message = { method?: string; params?: Record<string, unknown> };
const methods = (messages: Message[]) => messages.flatMap(({ method }) => typeof method === "string" ? [method] : []);
const turnText = (messages: Message[]) => {
  const turn = messages.find(({ method }) => method === "turn/start");
  return turn ? ((turn.params!.input as { type: string; text?: string }[])[0]!.text ?? null) : null;
};

describe("Codex App Server native history injection", { concurrent: false }, () => {
  const roots: string[] = [];
  const managers: ProviderManager[] = [];
  const originalCapture = process.env.INERTIA_APP_SERVER_CAPTURE;

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
    if (originalCapture === undefined) delete process.env.INERTIA_APP_SERVER_CAPTURE;
    else process.env.INERTIA_APP_SERVER_CAPTURE = originalCapture;
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  function start(environment: Record<string, string>, historyInjection: ProviderHistoryInjection | undefined,
    input: Partial<ProviderRunInput> = {}) {
    const fake = fakeAppServer(roots);
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    const manager = ProviderManager.createForTests({
      commands: { codex: fake.command },
      resolveBackendLaunchOptions: (_input, base) => ({
        environment: { ...base, INERTIA_APP_SERVER_CAPTURE: fake.capturePath, ...environment },
      }),
    });
    managers.push(manager);
    const conversationId = `conversation-injection-${roots.length}`;
    const result = manager.run(nativeProviderRunInput({
      providerId: "codex", conversationId, cwd: fake.root, prompt: INLINE_PROMPT,
      interactionMode: "build", access: "supervised", ...input,
    }), {
      ...(historyInjection ? { historyInjection } : {}),
      onApproval: (event) => manager.respondToApproval(event.conversationId, event.request.requestId, "approve", {
        runId: event.runId, turnId: event.turnId }),
      onInput: (event) => manager.respondToInput(event.conversationId, event.request.requestId, { choice: ["Safe"] }, {
        runId: event.runId, turnId: event.turnId }),
    });
    return { fake, manager, conversationId, result, messages: () => captured(fake.capturePath) as Message[] };
  }

  it("injects the items on the opened thread, records delivery, then starts the turn without the history block", async () => {
    const { steps, injection } = recordingAuthority();
    const run = start({}, injection, { imagePaths: ["/attachments/screenshot.png"] });
    await expect(run.result).resolves.toMatchObject({ status: "completed" });
    const messages = run.messages();
    const order = methods(messages);
    expect(order.indexOf("thread/start")).toBeLessThan(order.indexOf("thread/inject_items"));
    expect(order.indexOf("thread/inject_items")).toBeLessThan(order.indexOf("turn/start"));
    expect(messages.find(({ method }) => method === "thread/inject_items")!.params).toEqual({
      threadId: "thread-new", items: historyItems });
    expect(steps).toEqual(["begin", "delivered"]);
    expect(turnText(messages)).toBe(NATIVE_PROMPT);
    // Injected history is text only: the current prompt's images stay on turn/start.
    const turn = messages.find(({ method }) => method === "turn/start")!;
    expect(turn.params!.input).toContainEqual({ type: "localImage", path: "/attachments/screenshot.png" });
  });

  it("injects into a resumed thread with the same thread id", async () => {
    const { steps, injection } = recordingAuthority();
    const run = start({}, injection, { sessionId: "thread-existing" });
    await expect(run.result).resolves.toMatchObject({ status: "completed", sessionId: "thread-existing" });
    const messages = run.messages();
    expect(messages.find(({ method }) => method === "thread/inject_items")!.params).toMatchObject({ threadId: "thread-existing" });
    expect(steps).toEqual(["begin", "delivered"]);
  });

  it.each([
    ["JSON-RPC method not found (-32601)", "unknown-method"],
    ["App Server 0.169.0's unknown variant (-32600)", "unknown-variant"],
  ])("falls back inline in the same turn when Codex does not know the method: %s", async (_label, scenario) => {
    const { steps, injection } = recordingAuthority();
    const run = start({ INERTIA_APP_SERVER_INJECT: scenario }, injection);
    const result = await run.result;
    expect(result).toMatchObject({ status: "completed" });
    expect(result.failure).toBeUndefined();
    expect(steps).toEqual(["begin", "unsupported"]);
    expect(turnText(run.messages())).toBe(INLINE_PROMPT);
  });

  it.each([
    ["a malformed response", { INERTIA_APP_SERVER_INJECT: "malformed" }],
    ["another JSON-RPC error", { INERTIA_APP_SERVER_INJECT: "error" }],
    ["another invalid request (-32600)", { INERTIA_APP_SERVER_INJECT: "invalid-request" }],
    ["a transport close during the request", { INERTIA_APP_SERVER_INJECT: "close" }],
  ])("fails the turn without starting it after %s, leaving delivery to the record", async (_label, environment) => {
    const { steps, injection } = recordingAuthority();
    const run = start(environment, injection);
    await expect(run.result).resolves.toMatchObject({ status: "failed" });
    expect(steps).toEqual(["begin"]);
    expect(methods(run.messages())).toContain("thread/inject_items");
    expect(methods(run.messages())).not.toContain("turn/start");
  });

  it("stops while the injection is pending without starting the turn", async () => {
    const { steps, injection } = recordingAuthority();
    const run = start({ INERTIA_APP_SERVER_INJECT: "hold" }, injection);
    await vi.waitFor(() => expect(methods(run.messages())).toContain("thread/inject_items"));
    expect(run.manager.cancel(run.conversationId)).toBe(true);
    await expect(run.result).resolves.toMatchObject({ status: "cancelled" });
    expect(steps).toEqual(["begin"]);
    expect(methods(run.messages())).not.toContain("turn/start");
  });

  it("sends items at the 64,000-byte cap whole and keeps a larger history inline", async () => {
    const atCap = itemsOfBytes(MAX_HISTORY_INJECTION_BYTES);
    expect(Buffer.byteLength(JSON.stringify(atCap))).toBe(64_000);
    const sent = recordingAuthority({ items: atCap });
    const first = start({}, sent.injection);
    await expect(first.result).resolves.toMatchObject({ status: "completed" });
    expect(first.messages().find(({ method }) => method === "thread/inject_items")!.params!.items).toEqual(atCap);
    expect(sent.steps).toEqual(["begin", "delivered"]);

    const over = recordingAuthority({ items: itemsOfBytes(MAX_HISTORY_INJECTION_BYTES + 1) });
    const second = start({}, over.injection);
    await expect(second.result).resolves.toMatchObject({ status: "completed" });
    expect(methods(second.messages())).not.toContain("thread/inject_items");
    expect(over.steps).toEqual([]);
    expect(turnText(second.messages())).toBe(INLINE_PROMPT);
  });

  it("sends nothing and keeps the history inline when the attempt could not record the start", async () => {
    const { steps, injection } = recordingAuthority({ begin: false });
    const run = start({}, injection);
    await expect(run.result).resolves.toMatchObject({ status: "completed" });
    expect(steps).toEqual(["begin"]);
    expect(methods(run.messages())).not.toContain("thread/inject_items");
    expect(turnText(run.messages())).toBe(INLINE_PROMPT);
  });

  it("starts no turn when the delivery could not be recorded", async () => {
    const { steps, injection } = recordingAuthority({ delivered: false });
    const run = start({}, injection);
    await expect(run.result).resolves.toMatchObject({ status: "failed" });
    expect(steps).toEqual(["begin", "delivered"]);
    expect(methods(run.messages())).not.toContain("turn/start");
  });

  it("starts no turn when Stop lands between the recorded delivery and turn/start", async () => {
    const { steps, injection } = recordingAuthority();
    let cancel = (): boolean => false;
    const run = start({}, { ...injection, delivered: () => { const recorded = injection.delivered(); cancel(); return recorded; } });
    cancel = () => run.manager.cancel(run.conversationId);
    await expect(run.result).resolves.toMatchObject({ status: "cancelled" });
    expect(steps).toEqual(["begin", "delivered"]);
    expect(methods(run.messages())).toContain("thread/inject_items");
    expect(methods(run.messages())).not.toContain("turn/start");
  });

  it("holds a goal change made during the injection until the turn has started", async () => {
    const { steps, injection } = recordingAuthority();
    const fake = fakeAppServer(roots);
    const run = startCodexAppServerRun({
      executable: fake.command,
      environment: { ...process.env, INERTIA_APP_SERVER_CAPTURE: fake.capturePath, INERTIA_APP_SERVER_INJECT: "slow" },
      cwd: fake.root, prompt: INLINE_PROMPT, planMode: false, access: "full", sessionId: "thread-goal-race",
      historyInjection: injection,
    });
    await vi.waitFor(() => expect(methods(captured(fake.capturePath) as Message[])).toContain("thread/inject_items"));
    // Goal mutations wait for the startup gate, which opens only after injection and turn/start.
    await expect(run.setGoal({ status: "active", objective: "Raced goal" })).resolves.toMatchObject({ status: "active" });
    const order = methods(captured(fake.capturePath) as Message[]);
    expect(order.indexOf("thread/inject_items")).toBeLessThan(order.indexOf("turn/start"));
    expect(order.indexOf("turn/start")).toBeLessThan(order.indexOf("thread/goal/set"));
    expect(steps).toEqual(["begin", "delivered"]);
    run.cancel(true);
    expect(["cancelled", "completed"]).toContain((await run.result).status);
  });

  it("records the turn as accepted from the turn/start response, before turn/started", async () => {
    const fake = fakeAppServer(roots);
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    const manager = ProviderManager.createForTests({ commands: { codex: fake.command },
      resolveBackendLaunchOptions: (_input, base) => ({ environment: { ...base, INERTIA_APP_SERVER_CAPTURE: fake.capturePath,
        INERTIA_APP_SERVER_SCENARIO: "turn-start-response-only" } }) });
    managers.push(manager);
    const boundaries: unknown[] = [];
    const conversationId = "conversation-turn-start-race";
    const result = manager.run(nativeProviderRunInput({ providerId: "codex", conversationId, cwd: fake.root,
      prompt: "Raced prompt", interactionMode: "build", access: "supervised", sessionId: "thread-race" }), {
      onEvent: (event) => { if (event.type === "native-boundary") boundaries.push(event); },
    });
    await vi.waitFor(() => expect(boundaries).toHaveLength(1));
    expect(boundaries[0]).toMatchObject({ nativeConversationId: "thread-race", nativeTurnId: "turn-1", phase: "started" });
    expect(manager.cancel(conversationId)).toBe(true);
    await expect(result).resolves.toMatchObject({ status: "cancelled" });
  });

  it("never injects into a thread Codex reports active", async () => {
    const { steps, injection } = recordingAuthority();
    const run = start({ INERTIA_APP_SERVER_THREAD_STATUS: "active" }, injection, { sessionId: "thread-busy" });
    await expect(run.result).resolves.toMatchObject({ status: "completed" });
    expect(steps).toEqual([]);
    expect(methods(run.messages())).not.toContain("thread/inject_items");
    expect(turnText(run.messages())).toBe(INLINE_PROMPT);
  });

  it("injects before thread/goal/set on a goal start", async () => {
    const { steps, injection } = recordingAuthority();
    const run = start({ INERTIA_APP_SERVER_SCENARIO: "goal-continuation" }, injection, {
      prompt: "/goal Ship it", access: "full", goalStart: { objective: "Ship it" }, goalContinuationExpected: true });
    await expect(run.result).resolves.toMatchObject({ status: "completed" });
    const order = methods(run.messages());
    expect(order.indexOf("thread/inject_items")).toBeGreaterThan(-1);
    expect(order.indexOf("thread/inject_items")).toBeLessThan(order.indexOf("thread/goal/set"));
    expect(order).not.toContain("turn/start");
    expect(steps).toEqual(["begin", "delivered"]);
  });

  it("offers nothing to inject without an authority and sends the inline prompt", async () => {
    const run = start({}, undefined);
    await expect(run.result).resolves.toMatchObject({ status: "completed" });
    expect(methods(run.messages())).not.toContain("thread/inject_items");
    expect(turnText(run.messages())).toBe(INLINE_PROMPT);
  });
});
