// @inertia-e2e-resource isolated
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "@playwright/test";

import type { Conversation } from "../../src/shared/contracts";
import { createCdpTransportFactory } from "../../src/server/runtime/app-under-test/cdp-window-transport";
import { AppUnderTestHostTools } from "../../src/server/runtime/app-under-test/host-tools";
import { AppUnderTestLaunchManager } from "../../src/server/runtime/app-under-test/launch-manager";
import type { ProviderHostToolCall } from "../../src/server/provider/contracts";

/**
 * One real Electron launch over the debugging pipe, through the runtime's
 * own launch manager, CDP transport and App host tools in a Supervised chat.
 * It drives the window only over CDP, so it needs no window-manager focus.
 * It needs Linux with a display (CI runs it under xvfb; locally use
 * `xvfb-run -a`) and the repository's own Electron binary.
 */

const require = createRequire(import.meta.url);
const fixture = resolve("tests/fixtures/app-under-test");
const electronBinary = (() => {
  try {
    const path = require("electron") as unknown;
    return typeof path === "string" && existsSync(path) ? realpathSync(path) : null;
  } catch {
    return null;
  }
})();
const runnable = process.platform === "linux" && Boolean(process.env.DISPLAY) && electronBinary !== null;
const conversationId = "77777777-7777-4777-8777-777777777777";
const conversation = { id: conversationId, accessMode: "supervised" } as Conversation;
const identity = {
  conversationId,
  runId: "88888888-8888-4888-8888-888888888888",
  turnId: "99999999-9999-4999-8999-999999999999",
  remoteDevice: false,
};

let dataDirectory = "";
let launches: AppUnderTestLaunchManager;
let tools: AppUnderTestHostTools;
const approvals: string[] = [];

function call(tool: string, args: Record<string, unknown> = {}): ProviderHostToolCall {
  return {
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
  };
}

async function tool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await tools.invoke(conversation, call(name, args), identity);
  const parsed = JSON.parse(result.text) as Record<string, unknown>;
  if (!result.success) throw new Error(`${name} failed: ${result.text}`);
  return parsed;
}

/** The project sends app screenshots to the agent, on a route whose model accepts images. */
const visualIdentity = { ...identity, visualEvidence: true, imagesAccepted: true };

interface Element {
  ref?: string;
  role: string;
  name: string;
  value?: string;
}

function ref(snapshot: Record<string, unknown>, role: string, name: string): string {
  const element = (snapshot.elements as Element[]).find((candidate) => candidate.role === role && candidate.name === name);
  if (!element?.ref) throw new Error(`No ${role} named ${name} in ${JSON.stringify(snapshot.elements)}`);
  return element.ref;
}

test.describe("App under test with a real Electron app", () => {
  test.skip(!runnable, "Needs Linux with a display and the repository's Electron binary.");

  test.beforeAll(async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "inertia-app-under-test-e2e-"));
    launches = new AppUnderTestLaunchManager({
      dataDirectory,
      workspace: () => ({ root: fixture, actions: [] }),
      cdpTransports: createCdpTransportFactory(),
      // Chromium refuses to run as root with its sandbox; CI runs as a user.
      electronSwitches: process.getuid?.() === 0 ? ["--no-sandbox"] : [],
      sourceEnvironment: async () => ({ env: { ...process.env }, pathEntries: [] }),
      resolveElectron: async () => ({
        root: realpathSync(fixture),
        executable: electronBinary!,
        appPath: realpathSync(fixture),
      }),
    });
    tools = new AppUnderTestHostTools(launches, { launchReadyMs: 15_000 });
  });

  test.afterAll(async () => {
    await launches?.dispose();
    if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
  });

  test("launches, reads, drives, captures and stops the app with confirmed cleanup", async () => {
    test.setTimeout(25_000);
    const launched = await tool("inertia_app_launch", { kind: "electron" });
    expect(launched).toMatchObject({ kind: "electron", state: "running", cdp: true });
    const launchId = launched.launchId as string;
    const windows = launched.windows as Array<{ windowId: string; title: string; origin: string | null }>;
    expect(windows).toHaveLength(1);
    const windowId = windows[0]!.windowId;
    expect(launched.nextStep).toContain("inertia_app_snapshot");

    await tool("inertia_app_wait_for", { windowId, text: "App under test fixture", timeoutMs: 10_000 });
    const listed = await tool("inertia_app_windows");
    expect(listed.windows).toEqual([
      expect.objectContaining({ windowId, launchId, title: "App under test fixture", origin: "file://" }),
    ]);

    const snapshot = await tool("inertia_app_snapshot", { windowId });
    expect(snapshot).toMatchObject({ title: "App under test fixture", url: "file://", windowId, launchId });
    expect(snapshot.text).toContain("Waiting for input");
    const password = (snapshot.elements as Element[]).find((element) => element.name === "Password");
    expect(password).toMatchObject({ value: "[redacted]" });
    expect(ref(snapshot, "link", "Details")).toMatch(/^e\d+$/u);

    const clicked = await tool("inertia_app_click", { windowId, ref: ref(snapshot, "button", "Change text") });
    expect(clicked).toMatchObject({ clicked: expect.any(String) });
    expect(await tool("inertia_app_wait_for", { windowId, text: "Button clicked", timeoutMs: 5_000 }))
      .toMatchObject({ matched: true });

    await tool("inertia_app_type", { windowId, ref: ref(snapshot, "input", "Name"), text: "Ada Lovelace" });
    const typed = await tool("inertia_app_snapshot", { windowId });
    expect((typed.elements as Element[]).find((element) => element.name === "Name")).toMatchObject({ value: "Ada Lovelace" });

    const confirmed = await tool("inertia_app_click", { windowId, ref: ref(snapshot, "button", "Delete draft"), dialog: "accept" });
    expect(confirmed.dialogs).toEqual([{ kind: "confirm", message: "Delete the draft?", answer: "accept" }]);
    expect(await tool("inertia_app_wait_for", { windowId, text: "Draft deleted", timeoutMs: 5_000 }))
      .toMatchObject({ matched: true });

    const screenshot = await tool("inertia_app_screenshot", { windowId });
    expect(screenshot).toMatchObject({ captured: true, note: "local evidence only", evidenceId: expect.any(String) });
    const evidence = launches.listEvidence(conversationId).find((entry) => entry.evidenceId === screenshot.evidenceId);
    expect(evidence).toMatchObject({ kind: "screenshot", hasThumbnail: true });
    expect(evidence!.thumbnail).toMatch(/^data:image\/png;base64,iVBORw0KGgo/u);
    expect(evidence!.width).toBeLessThanOrEqual(512);
    expect(evidence!.height).toBeLessThanOrEqual(320);

    // With the project's opt-in on an image-accepting route, one reduced PNG reaches the model.
    const visual = await tools.invoke(conversation, call("inertia_app_screenshot", { windowId }), visualIdentity);
    expect(visual.success, visual.text).toBe(true);
    const visualResult = JSON.parse(visual.text) as Record<string, unknown>;
    expect(visualResult).toMatchObject({
      captured: true, sentToAgent: true, note: "Coordinates from this image are not accepted by any tool; use refs from a snapshot.",
    });
    expect(visual.images).toHaveLength(1);
    const image = Buffer.from(visual.images![0]!.data, "base64");
    expect(visual.images![0]!.mimeType).toBe("image/png");
    expect(image.subarray(1, 4).toString("latin1")).toBe("PNG");
    const [imageWidth, imageHeight] = [image.readUInt32BE(16), image.readUInt32BE(20)];
    expect(visualResult).toMatchObject({ imageWidth, imageHeight });
    expect(Math.max(imageWidth, imageHeight)).toBeLessThanOrEqual(1_536);
    expect(imageWidth).toBeGreaterThan(512);
    expect(imageWidth * imageHeight).toBeLessThanOrEqual(720_000);
    expect(image.byteLength).toBeLessThanOrEqual(3_750_000);
    const sentEntry = launches.listEvidence(conversationId).find((entry) => entry.evidenceId === visualResult.evidenceId);
    expect(sentEntry).toMatchObject({ kind: "screenshot", label: "Screenshot sent to the agent", hasThumbnail: true });

    await tool("inertia_app_type", { windowId, ref: ref(snapshot, "input", "Password"), text: "hunter2-fixture" });
    const secret = await tool("inertia_app_snapshot", { windowId });
    expect(JSON.stringify(secret)).not.toContain("hunter2-fixture");
    expect((secret.elements as Element[]).find((element) => element.name === "Password")).toMatchObject({ value: "[redacted]" });
    // A filled password field withholds the model-visible copy with the local one.
    const withheld = await tools.invoke(conversation, call("inertia_app_screenshot", { windowId }), visualIdentity);
    expect(withheld.success).toBe(false);
    expect(withheld.images).toBeUndefined();
    expect(JSON.parse(withheld.text)).toMatchObject({ error: { code: "sensitive", retryable: false, dispatched: false } });

    const logs = await tool("inertia_app_logs", { launchId, grep: "fixture" });
    const lines = logs.lines as Array<{ stream: string; text: string }>;
    expect(lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ stream: "console", text: "fixture ready" }),
      expect.objectContaining({ stream: "console", text: "fixture button clicked" }),
    ]));
    // The pipe carries console lines; Chromium's own stderr copy stays off for Electron launches.
    expect(lines.filter(({ text }) => text.includes("fixture button clicked"))).toHaveLength(1);

    const stopped = await tool("inertia_app_stop", { launchId });
    expect(stopped).toMatchObject({ stopped: true, cleanupConfirmed: true });
    expect(approvals).toEqual(["Launch the app", "Click", "Type", "Click", "Type", "Stop the app"]);
    expect(launches.liveLaunchCount).toBe(0);
  });
});
