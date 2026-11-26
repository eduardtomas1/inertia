// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { writeNodeFlagExecutable } from "../helpers/portable-provider-fixture";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { closeElectronAfterTest } from "./support/electron-failure-evidence";

const metadataOnlyCodex = `
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS]\\n"); process.exit(0);
}
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === "initialize" ? { userAgent: "synthetic-metadata" }
    : message.method === "model/list" ? { data: [], nextCursor: null } : { rateLimits: null };
  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
});
`;

function kimiHoldFixtureSource(wirePath: string): string {
  return `
const fs = require("node:fs");
const args = process.argv.slice(2);
const record = event => fs.appendFileSync(${JSON.stringify(wirePath)}, JSON.stringify({ pid: process.pid, ...event }) + "\\n");
if (args[0] === "--version") { console.log("kimi 0.41.0"); process.exit(0); }
if (args[0] === "acp" && args[1] === "--help") { console.log("Usage: kimi acp - Agent Client Protocol"); process.exit(0); }
if (args[0] === "provider" && args[1] === "list") { console.log(JSON.stringify({ providers: { synthetic: {} } })); process.exit(0); }
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
let sessionId = "synthetic-kimi-queue-edit";
let held = null;
const chunk = text => send({ jsonrpc: "2.0", method: "session/update", params: {
  sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
} });
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  const text = message.params?.prompt?.map(part => part.text ?? "").join("") ?? undefined;
  record({ method: message.method, text });
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: {
    protocolVersion: 1, agentInfo: { name: "Kimi Code CLI", version: "0.41.0" },
    agentCapabilities: { sessionCapabilities: { resume: {} }, mcpCapabilities: { http: true } },
    authMethods: [],
  } });
  if (message.method === "session/new" || message.method === "session/resume") {
    if (message.params.sessionId) sessionId = message.params.sessionId;
    send({ jsonrpc: "2.0", id: message.id, result: {
      sessionId, modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] }, configOptions: [],
    } });
    return send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [] },
    } });
  }
  if (message.method === "session/cancel") {
    if (held !== null) send({ jsonrpc: "2.0", id: held, result: { stopReason: "cancelled" } });
    held = null;
    return;
  }
  if (message.method === "session/prompt") {
    if (text.includes("Hold this turn open.")) {
      held = message.id;
      return chunk("Holding turn open.");
    }
    chunk("Completed: " + text);
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported" } });
});
`;
}

let activeApp: AppFixture | undefined;
let bodyFailure: { error: unknown } | undefined;

test.afterEach(async () => {
  const app = activeApp;
  const failure = bodyFailure;
  activeApp = undefined;
  bodyFailure = undefined;
  if (app) await closeElectronAfterTest(() => app.close(), () => test.info(), failure);
});

test("queued messages sit in-flow above the composer and support in-place editing while preserving an unrelated draft", async () => {
  test.setTimeout(90_000);
  const additionalEnvironment: Record<string, string> = {};
  const app = activeApp = await createAppFixture({
    name: "queue-edit",
    initialState: "conversation",
    additionalEnvironment,
    codexAppServerSource: metadataOnlyCodex,
    beforeLaunch: async ({ testDirectory, workspaceDirectory }) => {
      const bin = join(testDirectory, "provider-bin");
      const home = join(testDirectory, "provider-home");
      await Promise.all([bin, home].map((path) => mkdir(path, { recursive: true })));
      const wirePath = join(home, "kimi-wire.jsonl");
      await writeFile(wirePath, "", "utf8");
      writeNodeFlagExecutable(bin, "kimi", kimiHoldFixtureSource(wirePath));
      const systemPaths = process.platform === "win32"
        ? [dirname(process.execPath), join(process.env.SystemRoot ?? "C:\\Windows", "System32")]
        : ["/usr/bin", "/bin"];
      Object.assign(additionalEnvironment, {
        PATH: [bin, ...systemPaths].join(delimiter),
        HOME: home,
        USERPROFILE: home,
        APPDATA: home,
        LOCALAPPDATA: home,
        XDG_CONFIG_HOME: home,
        XDG_CACHE_HOME: home,
        XDG_DATA_HOME: home,
        KIMI_CODE_HOME: home,
        NVM_BIN: "",
        NVM_DIR: "",
        KIMI_API_KEY: "",
        KIMI_CODE_API_KEY: "",
      });
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, {
        recoverInterruptedRuns: false,
      });
      try {
        const conversation = store.snapshot().conversations[0];
        if (!conversation) throw new Error("Conversation was not seeded.");
        store.updateConversation(conversation.id, {
          providerId: "kimi",
          modelSelection: providerNativeModelSelection({ providerId: "kimi" }),
        });
      } finally {
        store.close();
      }
    },
  });
  try {
    const page = app.page;
    const composer = page.getByRole("region", { name: "Message composer" });
    const input = composer.getByRole("textbox", { name: "Message" });

    await input.fill("Hold this turn open.");
    await composer.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("Holding turn open.", { exact: true })).toBeVisible({ timeout: 20_000 });

    // Queue a message with Tab.
    await input.fill("Original queued step");
    await input.press("Tab");
    const queueList = page.getByRole("list", { name: "Queued messages" });
    await expect(queueList).toContainText("Original queued step");

    // Verify in-flow geometry: queue slot sits strictly above the composer with zero overlap.
    const [queueBox, composerBox] = await Promise.all([
      queueList.boundingBox(),
      composer.boundingBox(),
    ]);
    expect(queueBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect(queueBox!.y + queueBox!.height).toBeLessThanOrEqual(composerBox!.y + 1);

    // Keep an unrelated draft in the composer, enter in-place Edit, save changes, and verify draft is restored.
    await input.fill("Unrelated draft");
    await page.getByRole("button", { name: "Edit queued message" }).click();
    const editBanner = composer.getByRole("region", { name: "Editing queued message" });
    await expect(editBanner).toBeVisible();
    await expect(input).toHaveValue("Original queued step");

    await input.fill("Edited queued step");
    await editBanner.getByRole("button", { name: "Save" }).click();
    await expect(editBanner).toBeHidden();
    await expect(input).toHaveValue("Unrelated draft");
    await expect(queueList).toContainText("Edited queued step");

    expect(app.rendererErrors).toEqual([]);
  } catch (error) {
    bodyFailure = { error };
    throw error;
  }
});
