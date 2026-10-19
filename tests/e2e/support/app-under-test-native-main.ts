import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "electron";

import { createAppControlService } from "../../../src/main/app-control-service";
import { RuntimeAppControlCoordinator } from "../../../src/main/runtime-app-control-coordinator";
import type { RuntimeProcessRecord } from "../../../src/main/runtime-supervisor-types";
import {
  parseRuntimeAppControlEvent,
  parseRuntimeAppControlResult,
} from "../../../src/node/runtime-app-control-protocol";
import { createAccessibilityTransportFactory } from "../../../src/server/runtime/app-under-test/accessibility-window-transport";
import { RuntimeAppControlBrokerClient } from "../../../src/server/runtime/app-under-test/app-control-broker-client";
import { AppUnderTestHostTools } from "../../../src/server/runtime/app-under-test/host-tools";
import { AppUnderTestLaunchManager } from "../../../src/server/runtime/app-under-test/launch-manager";
import type { ProviderHostToolCall } from "../../../src/server/provider/contracts";
import type { Conversation } from "../../../src/shared/contracts";

/**
 * Electron main process of the Linux AT-SPI scenario. It is Inertia's main
 * and runtime in one process: the real App control service forks the real
 * "Inertia App Control" utility worker (xa11y loaded through the shipped
 * binding), the runtime's broker client reaches main's coordinator through
 * the strict protocol parsers, and the runtime's launch manager and App host
 * tools drive the fixture app as a project action, which has no debugging
 * pipe and is therefore served over the accessibility transport.
 */

app.disableHardwareAcceleration();
const argument = (name: string): string => {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
  assert(value, `missing ${prefix}`);
  return value;
};
const fixture = argument("fixture");
const appElectron = argument("app-electron");
const deadline = setTimeout(() => {
  console.error("NATIVE_APP_TIMEOUT");
  app.exit(2);
}, 40_000);

const conversationId = "77777777-7777-4777-8777-777777777771";
const actionId = "66666666-6666-4666-8666-666666666661";
const conversation = { id: conversationId, accessMode: "supervised" } as Conversation;
const identity = {
  conversationId,
  runId: "88888888-8888-4888-8888-888888888881",
  turnId: "99999999-9999-4999-8999-999999999991",
  remoteDevice: false,
};
const approvals: string[] = [];

interface Element { ref?: string; role: string; name: string; value?: string }

function evidence(label: string): void {
  console.log(`NATIVE_APP_EVIDENCE ${label}`);
}

async function run(): Promise<void> {
  await app.whenReady();
  const profile = await mkdtemp(join(tmpdir(), "inertia-native-fixture-profile-"));
  const dataDirectory = await mkdtemp(join(tmpdir(), "inertia-native-app-under-test-"));
  const service = createAppControlService();
  // The runtime/main channel: every message is cloned and strictly parsed as it would be across processes.
  // This process plays the runtime too: the launch root is its direct child.
  const record = { appControlRequestIds: new Set<string>(), child: { pid: process.pid } } as unknown as RuntimeProcessRecord;
  let client!: RuntimeAppControlBrokerClient;
  const coordinator = new RuntimeAppControlCoordinator({
    broker: service,
    accepts: () => true,
    post: (_record, command) => {
      const parsed = parseRuntimeAppControlResult(structuredClone(command));
      assert(parsed, "main's App control result must parse on the runtime side");
      setImmediate(() => client.handle(parsed));
    },
  });
  client = new RuntimeAppControlBrokerClient((event) => {
    const parsed = parseRuntimeAppControlEvent(structuredClone(event));
    assert(parsed, "the runtime's App control request must parse in main");
    setImmediate(() => coordinator.handle(record, parsed));
  });
  const launches = new AppUnderTestLaunchManager({
    dataDirectory,
    workspace: () => ({
      root: fixture,
      actions: [{
        id: actionId,
        name: "Native fixture",
        executable: appElectron,
        args: [
          ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
          "--force-renderer-accessibility",
          `--user-data-dir=${profile}`,
          join(fixture, "main.cjs"),
        ],
      }],
    }),
    accessibilityTransports: createAccessibilityTransportFactory(client),
    sourceEnvironment: async () => ({ env: { ...process.env }, pathEntries: [] }),
  });
  const tools = new AppUnderTestHostTools(launches, { launchReadyMs: 20_000 });
  const call = (tool: string, args: Record<string, unknown>): ProviderHostToolCall => ({
    providerThreadId: "provider-thread",
    providerTurnId: "provider-turn",
    toolCallId: crypto.randomUUID(),
    tool,
    arguments: args,
    signal: new AbortController().signal,
    requestApproval: async (request: { title: string }) => {
      approvals.push(request.title);
      return "approve" as const;
    },
  });
  const tool = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const result = await tools.invoke(conversation, call(name, args), identity);
    if (!result.success) throw new Error(`${name} failed: ${result.text}`);
    return JSON.parse(result.text) as Record<string, unknown>;
  };
  const failing = async (name: string, args: Record<string, unknown>): Promise<{ code: string; message: string; dispatched: boolean }> => {
    const result = await tools.invoke(conversation, call(name, args), identity);
    assert.equal(result.success, false, `${name} should fail: ${result.text}`);
    return (JSON.parse(result.text) as { error: { code: string; message: string; dispatched: boolean } }).error;
  };
  const find = (snapshot: Record<string, unknown>, role: string, name: string): Element => {
    const element = (snapshot.elements as Element[]).find((candidate) => candidate.role === role && candidate.name === name);
    assert(element?.ref, `No ${role} named ${name} in ${JSON.stringify(snapshot.elements)}`);
    assert.match(element.ref, /^e\d+$/u);
    return element;
  };

  let launchId: string | null = null;
  try {
    const launched = await tool("inertia_app_launch", { kind: "action", actionId });
    assert.equal(launched.transport, "accessibility", JSON.stringify(launched));
    assert.equal(launched.cdp, false);
    launchId = launched.launchId as string;
    const opened = launched.windows as Array<{ windowId: string; title: string }> | undefined;
    assert(opened && opened.length === 1, `one native window: ${JSON.stringify(launched)}`);
    const windowId = opened[0]!.windowId;
    evidence("window-listed");

    await tool("inertia_app_wait_for", { windowId, text: "Waiting for input", timeoutMs: 10_000 });
    const listed = await tool("inertia_app_windows");
    assert.deepEqual((listed.windows as Array<{ windowId: string }>).map((window) => window.windowId), [windowId]);
    assert.equal(listed.protectedApps, undefined);

    const snapshot = await tool("inertia_app_snapshot", { windowId });
    console.log(`NATIVE_APP_SNAPSHOT ${JSON.stringify(snapshot).slice(0, 4_000)}`);
    assert.match(String(snapshot.text), /App under test fixture/u);
    assert.match(String(snapshot.text), /Waiting for input/u);
    const button = find(snapshot, "button", "Change text");
    const name = find(snapshot, "text_field", "Name");
    const password = (snapshot.elements as Element[]).find((element) => element.name === "Password");
    assert(password?.ref, "the password field is listed with a ref");
    assert.equal(password.value, "[redacted]", "a password field never reports its value");
    evidence("snapshot-refs");

    const clicked = await tool("inertia_app_click", { windowId, ref: button.ref });
    assert.equal(clicked.clicked, button.ref);
    assert.equal((await tool("inertia_app_wait_for", { windowId, text: "Button clicked", timeoutMs: 5_000 })).matched, true);
    evidence("button-pressed");

    // Chromium on Linux exposes no AT-SPI EditableText interface: setting a
    // value is refused before anything reaches the app, and inserting text
    // is a platform failure after which main recycles the worker.
    const refusedValue = await failing("inertia_app_type", { windowId, ref: name.ref, text: "Ada Lovelace" });
    assert.equal(refusedValue.code, "invalid", JSON.stringify(refusedValue));
    assert.equal(refusedValue.dispatched, false);
    assert.match(refusedValue.message, /does not support this action/u);
    const inserted = await failing("inertia_app_type", { windowId, ref: name.ref, text: "Ada", replace: false });
    assert.equal(inserted.code, "unavailable", JSON.stringify(inserted));
    const afterRecycle = await tool("inertia_app_snapshot", { windowId });
    const unchanged = (afterRecycle.elements as Element[]).find((element) => element.role === "text_field" && element.name === "Name");
    assert(unchanged?.ref && unchanged.value === undefined, JSON.stringify(unchanged));
    assert.match(String(afterRecycle.text), /Button clicked/u);
    evidence("value-refused");

    const shot = await tool("inertia_app_screenshot", { windowId });
    assert.equal(shot.captured, true, JSON.stringify(shot));
    assert.equal(shot.mayIncludeOverlappingWindows, true);
    const thumbnail = launches.listEvidence(conversationId).find((entry) => entry.evidenceId === shot.evidenceId);
    assert(thumbnail?.hasThumbnail && thumbnail.thumbnail?.startsWith("data:image/png;base64,iVBORw0KGgo"));
    assert(thumbnail.width! > 0 && thumbnail.width! <= 512 && thumbnail.height! > 0 && thumbnail.height! <= 320,
      `thumbnail ${thumbnail.width}x${thumbnail.height}`);
    evidence("x11-screenshot");

    // Even with the project's opt-in on an image-accepting route, an X11 region capture can show
    // other windows over the app: it stays local evidence and is never sent to the model.
    const visual = await tools.invoke(conversation, call("inertia_app_screenshot", { windowId }), { ...identity, visualEvidence: true, imagesAccepted: true });
    assert.equal(visual.success, true, visual.text);
    assert.equal(visual.images, undefined);
    const kept = JSON.parse(visual.text) as Record<string, unknown>;
    assert.equal(kept.sentToAgent, false, visual.text);
    assert.equal(kept.mayIncludeOverlappingWindows, true);
    assert.equal(kept.note, "local evidence only: on this platform the capture may include other windows, so it stays on this device.");
    const keptEntry = launches.listEvidence(conversationId).find((entry) => entry.evidenceId === kept.evidenceId);
    assert.equal(keptEntry?.label, "Screenshot", JSON.stringify(keptEntry && { ...keptEntry, thumbnail: null }));
    assert(keptEntry.hasThumbnail);
    evidence("x11-agent-image");

    // Synthesized input: refused until the window is brought to the front in this turn.
    const early = await failing("inertia_app_press", { windowId, key: "Escape" });
    assert.equal(early.code, "unavailable", JSON.stringify(early));
    assert.equal(early.dispatched, false);
    assert.match(early.message, /The app is not in front; call inertia_app_activate/u);
    const activated = await tool("inertia_app_activate", { windowId });
    assert.equal(activated.activated, true, JSON.stringify(activated));
    // XTest under Xvfb with Openbox: the key reaches the fixture's keydown handler.
    const pressed = await tool("inertia_app_press", { windowId, key: "Escape" });
    assert.equal(pressed.pressed, "Escape", JSON.stringify(pressed));
    assert.equal((await tool("inertia_app_wait_for", { windowId, text: "Escape pressed", timeoutMs: 5_000 })).matched, true);
    const scrolled = await tool("inertia_app_scroll", { windowId, deltaY: 300 });
    assert.equal(scrolled.scrolled, 300, JSON.stringify(scrolled));
    assert.equal(scrolled.wheelNotches, 3, JSON.stringify(scrolled));
    assert.equal((await tool("inertia_app_wait_for", { windowId, text: "Wheel scrolled down", timeoutMs: 5_000 })).matched, true);
    // The grant ends with the turn.
    tools.turnSettled(identity.turnId);
    const settled = await failing("inertia_app_press", { windowId, key: "Escape" });
    assert.match(settled.message, /inertia_app_activate/u);
    evidence("synthesized-input");

    // A secret is remembered before it is sent, so it stays hidden even though the app refuses it.
    const passwordRef = (afterRecycle.elements as Element[]).find((element) => element.name === "Password")!.ref!;
    const secretTyped = await failing("inertia_app_type", { windowId, ref: passwordRef, text: "hunter2-native" });
    assert.equal(secretTyped.code, "invalid", JSON.stringify(secretTyped));
    const secret = await tool("inertia_app_snapshot", { windowId });
    assert(!JSON.stringify(secret).includes("hunter2-native"));
    assert.equal((secret.elements as Element[]).find((element) => element.ref === passwordRef)?.value, "[redacted]");
    const withheld = await failing("inertia_app_screenshot", { windowId });
    assert.equal(withheld.code, "sensitive", JSON.stringify(withheld));
    evidence("password-redacted");

    const stopped = await tool("inertia_app_stop", { launchId });
    assert.equal(stopped.cleanupConfirmed, true, JSON.stringify(stopped));
    launchId = null;
    assert.deepEqual(approvals, ["Launch the app", "Click", "Type", "Type", "Bring the app window to the front", "Press", "Scroll", "Type", "Stop the app"]);
    assert.equal(launches.liveLaunchCount, 0);
    evidence("stopped-confirmed");
  } finally {
    if (launchId) await launches.stop(conversationId, launchId).catch(() => undefined);
    const disposed = await launches.dispose();
    client.close();
    coordinator.clear(record);
    await service.dispose();
    assert(disposed, "every launch was proved stopped");
    evidence("worker-stopped");
    await Promise.all([rm(profile, { recursive: true, force: true }), rm(dataDirectory, { recursive: true, force: true })]);
  }
}

void run().then(() => { clearTimeout(deadline); app.exit(0); }, (error: unknown) => {
  console.error(error);
  clearTimeout(deadline);
  app.exit(1);
});
