// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { executableProcessExists } from "../helpers/executable-process";
import { writeNodeFlagExecutable } from "../helpers/portable-provider-fixture";
import { setAppearanceInPlace } from "./support/appearance";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { closeElectronAfterTest } from "./support/electron-failure-evidence";

interface WireEvent {
  pid: number;
  method?: string;
  sessionId?: string;
  text?: string;
}

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

function kimiFixtureSource(wirePath: string): string {
  return `
const fs = require("node:fs");
const args = process.argv.slice(2);
const record = event => fs.appendFileSync(${JSON.stringify(wirePath)}, JSON.stringify({ pid: process.pid, ...event }) + "\\n");
if (args[0] === "--version") { console.log("kimi 0.41.0"); process.exit(0); }
if (args[0] === "acp" && args[1] === "--help") { console.log("Usage: kimi acp - Agent Client Protocol"); process.exit(0); }
if (args[0] === "provider" && args[1] === "list") { console.log(JSON.stringify({ providers: { synthetic: {} } })); process.exit(0); }
if (args.join(" ") !== "acp") throw new Error("Unexpected synthetic Kimi invocation.");
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
let sessionId = "synthetic-kimi-stop-session";
let held = null;
const chunk = text => send({ jsonrpc: "2.0", method: "session/update", params: {
  sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
} });
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  const text = message.params?.prompt?.map(part => part.text ?? "").join("") ?? undefined;
  record({ method: message.method, sessionId: message.params?.sessionId, text });
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
    if (text.includes("Keep working until I interrupt you.")) {
      held = message.id;
      return chunk("Working on the long task.");
    }
    chunk("Synthetic Kimi did the new request.");
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported synthetic Kimi RPC." } });
});
`;
}

async function wireEvents(path: string): Promise<WireEvent[]> {
  return (await readFile(path, "utf8")).trim().split("\n")
    .filter(Boolean).map(line => JSON.parse(line) as WireEvent);
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

test("Stop and send stops a Kimi run and sends the draft as the next turn in the same session", async () => {
  test.setTimeout(90_000);
  const testInfo = test.info();
  let wirePath = "";
  const additionalEnvironment: Record<string, string> = {};
  const app = activeApp = await createAppFixture({
    name: "composer-stop-and-send", initialState: "conversation", additionalEnvironment,
    codexAppServerSource: metadataOnlyCodex,
    beforeLaunch: async ({ testDirectory, workspaceDirectory }) => {
      const bin = join(testDirectory, "provider-bin");
      const home = join(testDirectory, "provider-home");
      await Promise.all([bin, home].map(path => mkdir(path, { recursive: true })));
      wirePath = join(home, "kimi-wire.jsonl");
      await writeFile(wirePath, "", "utf8");
      writeNodeFlagExecutable(bin, "kimi", kimiFixtureSource(wirePath));
      const systemPaths = process.platform === "win32"
        ? [dirname(process.execPath), join(process.env.SystemRoot ?? "C:\\Windows", "System32")]
        : ["/usr/bin", "/bin"];
      Object.assign(additionalEnvironment, {
        PATH: [bin, ...systemPaths].join(delimiter), HOME: home, USERPROFILE: home,
        APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home,
        XDG_CACHE_HOME: home, XDG_DATA_HOME: home, KIMI_CODE_HOME: home,
        NVM_BIN: "", NVM_DIR: "", KIMI_API_KEY: "", KIMI_CODE_API_KEY: "",
      });
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory,
        { recoverInterruptedRuns: false });
      try {
        const conversation = store.snapshot().conversations[0];
        if (!conversation) throw new Error("Synthetic Kimi conversation was not seeded.");
        store.updateConversation(conversation.id, {
          providerId: "kimi", modelSelection: providerNativeModelSelection({ providerId: "kimi" }),
        });
      } finally { store.close(); }
    },
  });
  try {
    const page = app.page;
    const composer = page.getByRole("region", { name: "Message composer" });
    const input = composer.getByRole("textbox", { name: "Message" });
    await input.fill("Keep working until I interrupt you.");
    await composer.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("Working on the long task.", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(composer.getByRole("button", { name: "Stop agent" })).toBeVisible();
    await expect(input).toHaveAttribute("placeholder", "Enter stops and sends · Tab queues");
    const capture = async (state: string): Promise<void> => {
      for (const [theme, width, height] of [
        ["light", 1440, 920],
        ["dark", 1440, 920],
        ["light", 760, 600],
        ["dark", 760, 600],
      ] as const) {
        await app.resizeWindow(width, height);
        await setAppearanceInPlace(app, theme);
        const name = `${state}-${theme}-${width}x${height}.png`;
        const path = testInfo.outputPath(name);
        await page.screenshot({ path, animations: "disabled", scale: "css" });
        await testInfo.attach(name, { path, contentType: "image/png" });
      }
      await app.resizeWindow(1440, 920);
      await setAppearanceInPlace(app, "light");
    };
    await capture("running-empty");

    await input.fill("Do this instead.");
    await expect(composer.getByRole("button", { name: "Stop and send" })).toBeVisible();
    await capture("running-draft");
    await input.focus();

    await input.press("Enter");
    await expect(page.getByText("Synthetic Kimi did the new request.", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    const stopped = page.locator("[data-turn-id]").filter({ has: page.getByText("Keep working until I interrupt you.", { exact: true }) });
    await expect(stopped.locator('[data-turn-status="cancelled"]')).toBeVisible();
    const sent = page.locator("[data-turn-id]").filter({ has: page.getByText("Do this instead.", { exact: true }) });
    await expect(sent.locator('[data-turn-status="completed"]')).toBeVisible();
    await expect(page.getByRole("list", { name: "Queued messages" })).toHaveCount(0);
    await expect(composer.getByRole("button", { name: "Send message" })).toBeVisible();

    const events = await wireEvents(wirePath);
    const prompts = events.filter(event => event.method === "session/prompt");
    expect(prompts.map(event => event.text)).toEqual([
      expect.stringContaining("Keep working until I interrupt you."),
      expect.stringContaining("Do this instead."),
    ]);
    expect(events.filter(event => event.method === "session/cancel")).toHaveLength(1);
    expect(prompts[1]?.sessionId).toBe(prompts[0]?.sessionId);
    await expect.poll(() => events.every(event => !executableProcessExists(event.pid))).toBe(true);
    expect(app.rendererErrors).toEqual([]);
  } catch (error) {
    bodyFailure = { error };
    throw error;
  }
});
