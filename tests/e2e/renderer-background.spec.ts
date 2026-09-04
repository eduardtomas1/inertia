import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture } from "./support/app-fixture";

function seedLargeHistory(testDirectory: string, workspaceDirectory: string): void {
  const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, {
    recoverInterruptedRuns: false,
  });
  try {
    const projectId = store.shellSnapshot().activeProjectId!;
    const conversation = store.createConversation(projectId, "Background history fixture");
    store.updateConversation(conversation.id, {
      reasoningEffort: "ultra",
      modelSelection: { ...conversation.modelSelection, reasoningEffort: "ultra" },
    });
    for (let index = 0; index < 128; index++) {
      const requestedAt = new Date(Date.now() - 200_000 + index * 1_000).toISOString();
      const { turn } = store.beginAgentTurn({
        id: `background-turn-${index}`, runId: `background-run-${index}`,
        conversationId: conversation.id, content: `History request ${index}`,
        providerId: "codex", harnessId: "codex-app-server", backendProfileId: "native:codex:app-server",
        model: "gpt-5.6", reasoningEffort: "ultra", interactionMode: "build", accessMode: "supervised",
        configurationRevision: 1, association: "authoritative", requestedAt,
      });
      for (let activity = 0; activity < 74; activity++) store.addActivity({
        conversationId: conversation.id, turnId: turn.id, runId: turn.runId,
        kind: "command", title: `Command ${index}.${activity}`,
        detail: "Synthetic bounded-history fixture. ".repeat(20), status: "completed",
      });
      for (let message = 0; message < 6; message++) store.createMessage(
        conversation.id, `Commentary ${index}.${message}`, "assistant", [], turn.id, requestedAt,
      );
      const answer = store.createMessage(conversation.id, `Final answer ${index}`, "assistant", [], turn.id, requestedAt);
      store.updateAgentTurnLifecycle(turn.id, {
        status: "completed", startedAt: requestedAt, completedAt: requestedAt, updatedAt: requestedAt,
        terminalAssistantMessageId: answer.id, terminalReason: "provider-completed",
      });
    }
  } finally { store.close(); }
}

async function processMetrics(electronApp: ElectronApplication) {
  return electronApp.evaluate(({ app, BrowserWindow }) => {
    const rendererPid = BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().startsWith("file:"))?.webContents.getOSProcessId();
    return app.getAppMetrics().filter((metric) => metric.pid === rendererPid || metric.type === "GPU")
      .map((metric) => ({
        role: metric.pid === rendererPid ? "renderer" : "gpu", pid: metric.pid,
        cpuPercent: metric.cpu.percentCPUUsage, workingSetKb: metric.memory.workingSetSize,
        privateKb: metric.memory.privateBytes,
      }));
  });
}

async function sample(page: Page, electronApp: ElectronApplication, name: string) {
  const session = await page.context().newCDPSession(page);
  const trace: { name: string; dur?: number; ph: string }[] = [];
  session.on("Tracing.dataCollected", ({ value }) => {
    const events = value as unknown as typeof trace;
    if (trace.length < 50_000) trace.push(...events.slice(0, 50_000 - trace.length));
  });
  await session.send("Tracing.start", {
    categories: "devtools.timeline,v8,disabled-by-default-devtools.timeline",
    transferMode: "ReportEvents",
  });
  await processMetrics(electronApp);
  const start = await page.evaluate(() => ({
    focus: document.hasFocus(), visibility: document.visibilityState,
    animations: document.getAnimations().map((animation) => ({
      state: animation.playState, time: animation.currentTime,
      name: animation instanceof CSSAnimation ? animation.animationName : "web-animation",
    })),
  }));
  await page.waitForTimeout(5_000);
  const processes = await processMetrics(electronApp);
  const heap = await session.send("Runtime.getHeapUsage");
  const end = await page.evaluate(() => ({
    focus: document.hasFocus(), visibility: document.visibilityState,
    animations: document.getAnimations().map((animation) => ({
      state: animation.playState, time: animation.currentTime,
      name: animation instanceof CSSAnimation ? animation.animationName : "web-animation",
    })),
    mountedRows: document.querySelectorAll(".response-virtual-item").length,
    domNodes: document.querySelectorAll("*").length,
  }));
  const completed = new Promise<void>((resolve) => session.once("Tracing.tracingComplete", () => resolve()));
  await session.send("Tracing.end");
  await completed;
  await session.detach();
  const eventTotals: Record<string, { count: number; durationMs: number }> = {};
  for (const event of trace) {
    if (!/^(FireAnimationFrame|FunctionCall|TimerFire|Layout|UpdateLayoutTree|Paint|CompositeLayers|.*GC.*)$/u.test(event.name)) continue;
    const total = eventTotals[event.name] ??= { count: 0, durationMs: 0 };
    total.count++;
    total.durationMs += (event.dur ?? 0) / 1_000;
  }
  return { name, durationMs: 5_000, start, end, processes, heap, eventTotals, traceEvents: trace.length };
}

test("bounds background motion for a large virtualized conversation and resumes on focus", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const fixture = await createAppFixture({
    name: "renderer-background", initialState: "conversation", windowDisplay: "primary",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => seedLargeHistory(testDirectory, workspaceDirectory),
  });
  const { page, electronApp } = fixture;
  try {
    const focusSession = await page.context().newCDPSession(page);
    await focusSession.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    await expect(page.getByRole("heading", { name: "Background history fixture", level: 1 })).toBeVisible();
    await expect(page.getByRole("feed", { name: "128 conversation turns" })).toBeVisible();
    await expect.poll(() => page.locator(".response-virtual-item").count()).toBeLessThan(24);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.focus());
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    const foreground = await sample(page, electronApp, "foreground");
    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const other = new BrowserWindow({ width: 180, height: 120, x: 0, y: 0, show: true });
      await other.loadURL("data:text/html,<title>Focus fixture</title>");
      for (const window of BrowserWindow.getAllWindows()) if (window !== other) window.blur();
      other.focus();
      other.webContents.focus();
    });
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
    expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
    const background = await sample(page, electronApp, "mapped-unfocused");
    await electronApp.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.webContents.getURL().startsWith("data:")) window.destroy();
        else window.focus();
      }
    });
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    const resumed = await sample(page, electronApp, "resumed");
    const report = JSON.stringify({ turns: 128, activities: 9472, messages: 1024, foreground, background, resumed }, null, 2);
    await mkdir("performance-results", { recursive: true });
    await writeFile(`performance-results/renderer-background-${process.platform}-${process.arch}.json`, report);
    await testInfo.attach("renderer-background-profile", {
      body: Buffer.from(report),
      contentType: "application/json",
    });
    expect(fixture.rendererErrors).toEqual([]);
  } finally { await fixture.close(); }
});
