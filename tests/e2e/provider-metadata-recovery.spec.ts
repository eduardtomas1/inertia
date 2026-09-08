// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";

import type { ProviderInfo, ServerEvent } from "../../src/shared/contracts";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

const source = `
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
const fs = require("node:fs");
const send = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send(message.id, { userAgent: "metadata-recovery-fixture" });
  if (message.method === "account/rateLimits/read") send(message.id, { rateLimits: null });
  if (message.method === "model/list") {
    fs.appendFileSync("metadata-attempts.txt", "read\\n");
    send(message.id, { data: fs.existsSync("catalog-ready") ? [{
      model: "recovered-model", displayName: "Recovered fixture model",
      isDefault: true, inputModalities: ["text"],
      supportedReasoningEfforts: [], defaultReasoningEffort: "medium"
    }] : "malformed-initial-catalog", nextCursor: null });
  }
});
`;

let app: AppFixture | undefined;
let socket: WebSocket | undefined;

test.afterEach(async () => {
  socket?.terminate();
  await app?.close();
});

test("recovers an initially unavailable catalog through Settings Refresh without restarting", async ({ browserName: _browserName }, testInfo) => {
  app = await createAppFixture({
    name: "provider-metadata-recovery", initialState: "conversation",
    codexAppServerSource: source,
    claudeAuthSource: "process.exit(1);",
  });
  const originalRuntime = await app.runtimeSnapshot();
  if (!originalRuntime.websocketUrl) throw new Error("Fixture runtime is unavailable.");
  let provider: ProviderInfo | undefined;
  socket = new WebSocket(originalRuntime.websocketUrl, {
    origin: "inertia://bundle", maxPayload: 2 * 1024 * 1024,
  });
  let socketError: Error | undefined;
  socket.on("error", (error) => { socketError = error; });
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as ServerEvent;
    const event = frame.type === "runtime.event" ? frame.event : frame;
    if (event.type === "server.welcome" || event.type === "snapshot.updated") {
      provider = event.snapshot.providers.find(({ id }) => id === "codex");
    }
  });
  await expect.poll(() => {
    if (socketError) throw socketError;
    return provider?.metadataState.models.lastAttemptedAt;
  }).toEqual(expect.any(String));
  expect(provider).toMatchObject({
    canRun: true, models: [],
    metadataState: { models: { freshness: "unavailable", refreshing: false } },
  });
  const attemptsPath = join(app.workspaceDirectory, "metadata-attempts.txt");
  expect(await readFile(attemptsPath, "utf8")).toBe("read\n");

  const page = app.page;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await page.getByRole("tab", { name: "Models", exact: true }).click();
  await expect(page.getByText("No models reported yet", { exact: true })).toBeVisible();
  await expect(page.getByText("Refresh or connect this provider to load its model catalog.", { exact: true })).toBeVisible();
  const emptyScreenshot = testInfo.outputPath("provider-catalog-unavailable.png");
  await page.screenshot({ path: emptyScreenshot, animations: "disabled" });
  await testInfo.attach("provider-catalog-unavailable", { path: emptyScreenshot, contentType: "image/png" });
  await writeFile(join(app.workspaceDirectory, "catalog-ready"), "ready\n");
  await page.locator(".provider-settings-editor")
    .getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Models 1", exact: true })).toBeVisible();
  await expect(page.getByText("Recovered fixture model", { exact: true })).toBeVisible();
  const recoveredScreenshot = testInfo.outputPath("provider-catalog-recovered.png");
  await page.screenshot({ path: recoveredScreenshot, animations: "disabled" });
  await testInfo.attach("provider-catalog-recovered", { path: recoveredScreenshot, contentType: "image/png" });
  await expect.poll(() => provider?.models.map(({ id }) => id)).toEqual(["recovered-model"]);
  expect(await readFile(attemptsPath, "utf8")).toBe("read\nread\n");
  expect(await app.runtimeSnapshot()).toMatchObject({
    phase: "ready", pid: originalRuntime.pid, generation: originalRuntime.generation,
  });
  expect(app.rendererErrors).toEqual([]);
});
