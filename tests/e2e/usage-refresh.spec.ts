// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

const usageCodexAppServer = `
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const readline = require("node:readline");
appendFileSync(join(__dirname, "codex-calls.log"), process.argv.slice(2).join(" ") + "\\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
const quotaMode = () => {
  try { return readFileSync(join(__dirname, "quota-mode"), "utf8").trim(); } catch { return "fail"; }
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "usage-refresh-fixture" } });
    return;
  }
  if (message.method === "model/list") {
    send({ id: message.id, result: { data: [{ id: "fixture", model: "fixture", displayName: "Fixture", isDefault: true }], nextCursor: null } });
    return;
  }
  if (message.method === "account/rateLimits/read") {
    const mode = quotaMode();
    const respond = () => {
      if (mode.startsWith("ok")) {
        send({ id: message.id, result: { rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 38, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 7200 },
          secondary: { usedPercent: 11, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 400000 },
        }, rateLimitsByLimitId: null } });
      } else {
        send({ id: message.id, error: { code: -32000, message: "usage unavailable" } });
      }
    };
    if (!mode.endsWith("slow")) {
      respond();
      return;
    }
    const gate = setInterval(() => {
      if (!existsSync(join(__dirname, "quota-release"))) return;
      clearInterval(gate);
      respond();
    }, 25);
    return;
  }
  send({ id: message.id, result: {} });
});
`;

let app!: AppFixture;

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "usage-refresh",
    initialState: "conversation",
    codexAppServerSource: usageCodexAppServer,
    beforeLaunch: async ({ workspaceDirectory }) => {
      await writeFile(join(workspaceDirectory, "quota-mode"), "fail", "utf8");
      await appendFile(
        join(workspaceDirectory, ".git", "info", "exclude"),
        "quota-mode\nquota-release\ncodex-calls.log\n",
        "utf8",
      );
    },
  });
});

test.afterAll(async () => {
  await app.close();
});

async function detectionProbes(): Promise<number> {
  const calls = await readFile(join(app.workspaceDirectory, "codex-calls.log"), "utf8").catch(() => "");
  return calls.split("\n").filter((call) => call === "--help").length;
}

test("Refresh usage shows its progress, reports a failed read and reads only quota", async () => {
  const { page } = app;
  const panel = await ensureWorkspaceTools(page);
  await selectWorkspaceTool(panel, "Usage");
  const usage = page.getByRole("region", { name: "Usage", exact: true });
  const refresh = usage.getByRole("button", { name: "Refresh usage" });
  await expect(refresh).toBeEnabled({ timeout: 30_000 });
  await expect.poll(detectionProbes, { timeout: 30_000 }).toBeGreaterThan(0);
  const probesBefore = await detectionProbes();

  await writeFile(join(app.workspaceDirectory, "quota-mode"), "fail-slow", "utf8");
  await refresh.click();
  const pending = usage.getByRole("button", { name: "Refreshing…" });
  await expect(pending).toBeDisabled();
  await expect(usage.locator(".workspace-surface-heading small")).toHaveText("Refreshing");
  await writeFile(join(app.workspaceDirectory, "quota-release"), "", "utf8");
  await expect(usage.getByRole("status")).toHaveText("Could not refresh. Showing cached usage.");
  await expect(refresh).toBeEnabled();

  await rm(join(app.workspaceDirectory, "quota-release"));
  await writeFile(join(app.workspaceDirectory, "quota-mode"), "ok-slow", "utf8");
  await refresh.click();
  await expect(pending).toBeDisabled();
  await writeFile(join(app.workspaceDirectory, "quota-release"), "", "utf8");
  await expect(usage.getByRole("status")).toHaveCount(0);
  await expect(usage.getByText("62% left")).toBeVisible();
  await expect(usage.getByText("89% left")).toBeVisible();
  await expect(usage.locator(".workspace-surface-heading small")).toHaveText("Current");
  await expect(usage.getByRole("button", { name: /Refresh/u })).toHaveCount(0);
  expect(await detectionProbes()).toBe(probesBefore);
  expect(app.rendererErrors).toEqual([]);
});
