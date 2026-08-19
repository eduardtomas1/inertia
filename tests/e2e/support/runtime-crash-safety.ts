import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
  processExists,
  type AppFixture,
  type RuntimeTestSnapshot,
} from "./app-fixture";
import {
  ensureWorkspaceTools,
  selectWorkspaceTool,
} from "./workspace-tools";

export async function expectRuntimeCrashRecovery(app: AppFixture): Promise<void> {
  const { electronApp, page, runtimeSnapshot, testDirectory } = app;
  await expect.poll(
    async () => (await runtimeSnapshot()).phase,
    { timeout: 15_000 },
  ).toBe("ready");
  const before = await runtimeSnapshot();
  const beforeUrl = await page.evaluate(() =>
    window.inertia.getRuntimeConnection().then(({ websocketUrl }) => websocketUrl));
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-runtime-generation",
    /^[0-9a-f-]{36}$/iu,
  );
  const beforeRuntimeGeneration = await page.locator(".app-shell")
    .getAttribute("data-runtime-generation");
  expect(beforeRuntimeGeneration).toMatch(/^[0-9a-f-]{36}$/iu);
  const tools = await ensureWorkspaceTools(page);
  await selectWorkspaceTool(tools, "Terminal");
  const terminal = page.locator("aside.terminal-panel").first();
  const restartTerminal = terminal.getByRole("button", { name: "Start again" });
  let retriedTerminalAdmission = false;
  await expect.poll(async () => {
    if (await terminal.getAttribute("data-terminal-id")) return true;
    if (
      !retriedTerminalAdmission
      && await restartTerminal.isVisible().catch(() => false)
    ) {
      retriedTerminalAdmission = true;
      await restartTerminal.click();
    }
    return false;
  }, { timeout: 5_000 }).toBe(true);
  await expect(terminal).toHaveAttribute("data-terminal-id", /.+/u);
  const beforeTerminalId = await terminal.getAttribute("data-terminal-id");
  expect(beforeTerminalId).toBeTruthy();
  if (process.platform === "linux") {
    // Keep the exact claimed terminal root alive after the utility process is
    // killed. An ordinary interactive shell exits when its PTY owner dies,
    // which intentionally exercises the separate missing-root fail-closed
    // boundary instead of the positive exact-identity recovery path below.
    // Encode the marker embedded in the command so terminal echo cannot make
    // the readiness assertion pass before exec installs the SIGHUP handler.
    const recoveryRootReadyMarker = "INERTIA_RECOVERY_ROOT_READY";
    const encodedReadyMarker = Buffer.from(
      `${recoveryRootReadyMarker}\n`,
      "utf8",
    ).toString("base64");
    const recoveryRootSource = [
      "process.on('SIGHUP', () => undefined);",
      `process.stdout.write(Buffer.from(${JSON.stringify(encodedReadyMarker)},'base64'));`,
      "setInterval(() => undefined, 1000);",
    ].join("");
    const terminalInput = terminal.locator(".xterm-helper-textarea");
    await terminalInput.focus();
    await page.keyboard.insertText(
      `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(recoveryRootSource)}`,
    );
    await page.keyboard.press("Enter");
    await expect(terminal).toContainText(recoveryRootReadyMarker);
  }
  const database = new Database(join(testDirectory, "data", "inertia.sqlite"));
  const conversation = database.prepare(`
    SELECT conversations.id
    FROM conversations
    JOIN app_state ON app_state.active_conversation_id = conversations.id
    WHERE app_state.id = 1
  `).get() as { id: string };
  const conversationCount = (database.prepare(
    "SELECT COUNT(*) AS count FROM conversations",
  ).get() as { count: number }).count;
  database.prepare("UPDATE conversations SET status = 'running' WHERE id = ?")
    .run(conversation.id);
  database.prepare("INSERT INTO messages (id, conversation_id, role, content, attachments_json, created_at) VALUES (?, ?, 'assistant', ?, '[]', ?)")
    .run(
      randomUUID(),
      conversation.id,
      "# Timeline response\n\n```ts file=src/timeline.ts\nconst ready: boolean = true;\n```\n\n| Check | State |\n| --- | --- |\n| Renderer | ready |\n\n<script>window.__unsafeMarkdown = true</script>",
      new Date(Date.now() - 1_000).toISOString(),
    );
  database.prepare("INSERT INTO activities (id, conversation_id, run_id, kind, title, detail, status, created_at) VALUES (?, ?, ?, 'command', 'Interrupted E2E command', NULL, 'running', ?)")
    .run(randomUUID(), conversation.id, "e2e-interrupted-run", new Date().toISOString());
  database.close();
  await page.evaluate(() => {
    Reflect.set(window, "__inertiaNoReloadMarker", crypto.randomUUID());
  });
  const marker = await page.evaluate(() =>
    Reflect.get(window, "__inertiaNoReloadMarker") as string);

  const crashed = await electronApp.evaluate((_electron) => {
    const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
      crash: () => RuntimeTestSnapshot;
    } | undefined;
    if (!runtime) throw new Error("The test runtime supervisor is unavailable");
    return runtime.crash();
  });
  expect(crashed.pid).toBe(before.pid);

  await expect.poll(async () => {
    const current = await runtimeSnapshot();
    return current.phase === "ready" && current.generation > before.generation;
  }, { timeout: 10_000 }).toBe(true);
  const after = await runtimeSnapshot();
  const afterUrl = await page.evaluate(() =>
    window.inertia.getRuntimeConnection().then(({ websocketUrl }) => websocketUrl));
  expect(after.generation).toBeGreaterThan(before.generation);
  expect(after.pid).not.toBe(before.pid);
  expect(afterUrl).not.toBe(beforeUrl);
  await expect.poll(() => page.locator(".app-shell")
    .getAttribute("data-runtime-generation")).not.toBe(beforeRuntimeGeneration);
  expect(await page.evaluate(() =>
    Reflect.get(window, "__inertiaNoReloadMarker"))).toBe(marker);
  await expect(page.getByRole("heading", { name: "New chat", level: 1 })).toBeVisible();
  const newChat = page.getByRole("button", { name: "New chat" }).first();
  const interruptedNotice = page.getByText(
    "The previous run ended when Inertia closed. Send another message to continue.",
  );
  await expect(page.getByRole("heading", { name: "Timeline response", level: 1 }))
    .toBeVisible();
  await expect(page.getByRole("button", { name: "Copy" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Markdown" })).toBeVisible();
  expect(await page.evaluate(() =>
    Reflect.get(window, "__unsafeMarkdown"))).toBeUndefined();
  const safetyAlert = page.locator(".error-toast[role=\"alert\"]");
  if (process.platform !== "linux") {
    await expect(interruptedNotice).toHaveCount(0);
    await expect(safetyAlert).toContainText(
      "Changes are unavailable in recovery safety mode.",
    );
    await expect(terminal).not.toHaveAttribute("data-terminal-id", /.+/u);
    await safetyAlert.getByRole("button", { name: "Dismiss error" }).click();
    await expect(safetyAlert).toHaveCount(0);
    await newChat.click();
    await expect(safetyAlert).toContainText(
      "Changes are unavailable in recovery safety mode.",
    );
    const preserved = new Database(join(testDirectory, "data", "inertia.sqlite"), {
      readonly: true,
    });
    try {
      expect((preserved.prepare("SELECT COUNT(*) AS count FROM conversations")
        .get() as { count: number }).count).toBe(conversationCount);
      expect(preserved.prepare("SELECT status FROM conversations WHERE id = ?")
        .get(conversation.id)).toEqual({ status: "running" });
      expect(preserved.prepare("SELECT status FROM activities WHERE run_id = ?")
        .get("e2e-interrupted-run")).toEqual({ status: "running" });
    } finally {
      preserved.close();
    }
    if (before.pid) {
      await expect.poll(() => processExists(before.pid as number), {
        timeout: 5_000,
      }).toBe(false);
    }
    return;
  }
  await expect(newChat).toBeEnabled();
  await expect(interruptedNotice).toBeVisible();
  await expect(terminal).toHaveAttribute("data-terminal-id", /.+/u);
  await expect.poll(() => terminal.getAttribute("data-terminal-id"))
    .not.toBe(beforeTerminalId);
  await expect(terminal.locator(".terminal-overlay[role=\"status\"]"))
    .toHaveCount(0);
  await expect(safetyAlert).toHaveCount(0);
  await newChat.click();
  await expect.poll(() => {
    const current = new Database(join(testDirectory, "data", "inertia.sqlite"), {
      readonly: true,
    });
    try {
      return (current.prepare("SELECT COUNT(*) AS count FROM conversations")
        .get() as { count: number }).count;
    } finally {
      current.close();
    }
  }).toBe(conversationCount + 1);
  await expect(safetyAlert).toHaveCount(0);
  const preserved = new Database(join(testDirectory, "data", "inertia.sqlite"), {
    readonly: true,
  });
  try {
    expect(preserved.prepare("SELECT status FROM conversations WHERE id = ?")
      .get(conversation.id)).toEqual({ status: "failed" });
    expect(preserved.prepare("SELECT status FROM activities WHERE run_id = ?")
      .get("e2e-interrupted-run")).toEqual({ status: "failed" });
    expect((preserved.prepare("SELECT COUNT(*) AS count FROM conversations")
      .get() as { count: number }).count).toBe(conversationCount + 1);
  } finally {
    preserved.close();
  }
  if (before.pid) {
    await expect.poll(() => processExists(before.pid as number), {
      timeout: 5_000,
    }).toBe(false);
  }
}
