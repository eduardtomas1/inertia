// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { mkdir, readFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { executableProcessExists } from "../helpers/executable-process";
import { writeNodeFlagExecutable } from "../helpers/portable-provider-fixture";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

interface WireEvent {
  kind: "launch" | "login" | "rpc";
  pid: number;
  args?: string[];
  tty?: boolean;
  method?: string;
  terminalAuth?: boolean;
  signedIn?: boolean;
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

function kimiFixtureSource(wirePath: string, signedInPath: string): string {
  return `
const fs = require("node:fs");
const args = process.argv.slice(2);
const signedIn = () => fs.existsSync(${JSON.stringify(signedInPath)});
const record = event => fs.appendFileSync(${JSON.stringify(wirePath)}, JSON.stringify({ pid: process.pid, ...event }) + "\\n");
record({ kind: "launch", args, tty: process.stdin.isTTY === true, signedIn: signedIn() });
if (args[0] === "--version") { console.log("kimi 0.41.0"); process.exit(0); }
if (args[0] === "acp" && args[1] === "--help") { console.log("Usage: kimi acp - Agent Client Protocol"); process.exit(0); }
if (args[0] === "provider" && args[1] === "list") {
  console.log(signedIn() ? JSON.stringify({ providers: { synthetic: {} } }) : "Not logged in");
  process.exit(signedIn() ? 0 : 1);
}
if (args.join(" ") === "acp --login") {
  if (!process.stdin.isTTY) throw new Error("Synthetic login requires the existing native PTY.");
  record({ kind: "login", args, tty: true });
  fs.writeFileSync(${JSON.stringify(signedInPath)}, "synthetic-account-only");
  process.stdout.write("Synthetic Kimi login complete.\\r\\n", () => process.exit(0));
  return;
}
if (args.join(" ") !== "acp") throw new Error("Unexpected synthetic Kimi invocation.");
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
const sessionId = "synthetic-kimi-terminal-session";
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  record({ kind: "rpc", method: message.method, terminalAuth: message.params?.clientCapabilities?.auth?.terminal, signedIn: signedIn() });
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: {
    protocolVersion: 1, agentInfo: { name: "Kimi Code CLI", version: "0.41.0" },
    agentCapabilities: { sessionCapabilities: { resume: {} }, mcpCapabilities: { http: true } },
    authMethods: [{ id: "login", name: "Kimi login", type: "terminal", args: ["--login"], env: {} }],
  } });
  if (message.method === "authenticate") throw new Error("Terminal descriptors must never be sent to authenticate.");
  if (!signedIn()) return send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Authentication required" } });
  if (message.method === "session/new" || message.method === "session/resume") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      sessionId, modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] }, configOptions: [],
    } });
    return send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [] },
    } });
  }
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Synthetic Kimi answer after terminal login." } },
    } });
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
  throw new Error("Unsupported synthetic Kimi RPC.");
});
`;
}

async function wireEvents(path: string): Promise<WireEvent[]> {
  return (await readFile(path, "utf8")).trim().split("\n")
    .filter(Boolean).map(line => JSON.parse(line) as WireEvent);
}

function durableCounts(app: AppFixture, conversationId: string): { completed: number; owners: number } {
  const database = new Database(join(app.testDirectory, "data", "inertia.sqlite"), { readonly: true });
  try {
    return {
      completed: (database.prepare("SELECT COUNT(*) AS count FROM agent_turns WHERE conversation_id = ? AND status = 'completed'")
        .get(conversationId) as { count: number }).count,
      owners: (database.prepare("SELECT COUNT(*) AS count FROM provider_run_ownership WHERE conversation_id = ?")
        .get(conversationId) as { count: number }).count,
    };
  } finally { database.close(); }
}

async function completeTurn(app: AppFixture, request: string): Promise<void> {
  const composer = app.page.getByRole("region", { name: "Message composer" });
  await composer.getByRole("textbox", { name: "Message" }).fill(request);
  await composer.getByRole("button", { name: "Send message" }).click();
  const turn = app.page.locator("[data-turn-id]").filter({ has: app.page.getByText(request, { exact: true }) });
  await expect(turn.locator('[data-turn-status="completed"]')).toBeVisible();
  await expect(turn.getByText("Synthetic Kimi answer after terminal login.", { exact: true })).toBeVisible();
}

let activeFixture: { app: AppFixture; wirePath: string } | undefined;

test.afterEach(async () => {
  const testInfo = test.info();
  const fixture = activeFixture;
  activeFixture = undefined;
  if (!fixture) return;
  try {
    if (testInfo.status !== testInfo.expectedStatus) {
      // Only the synthetic executable writes this wire: invocation metadata
      // and RPC method names, never provider credentials or prompt bodies.
      const wire = await wireEvents(fixture.wirePath).catch(() => []);
      await testInfo.attach("kimi-authentication-wire", {
        body: Buffer.from(JSON.stringify(wire, null, 2)), contentType: "application/json",
      });
    }
  } finally {
    // Teardown is a separate test hook so a cleanup failure cannot replace
    // the original login/turn/restart assertion in the reported result.
    await fixture.app.close();
  }
});

test("connects Kimi through a native login-only PTY then admits fresh ACP turns and restart", async () => {
  test.setTimeout(90_000);
  let conversationId = "";
  let wirePath = "";
  const additionalEnvironment: Record<string, string> = {};
  const app = await createAppFixture({
    name: "kimi-terminal-auth", initialState: "conversation", additionalEnvironment,
    codexAppServerSource: metadataOnlyCodex,
    beforeLaunch: async ({ testDirectory, workspaceDirectory }) => {
      const bin = join(testDirectory, "provider-bin");
      const home = join(testDirectory, "provider-home");
      await Promise.all([bin, home].map(path => mkdir(path, { recursive: true })));
      wirePath = join(home, "kimi-wire.jsonl");
      writeNodeFlagExecutable(bin, "kimi", kimiFixtureSource(wirePath, join(home, "kimi-connected")));
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
        conversationId = conversation.id;
        store.updateConversation(conversationId, {
          providerId: "kimi", modelSelection: providerNativeModelSelection({ providerId: "kimi" }),
        });
      } finally { store.close(); }
    },
  });
  activeFixture = { app, wirePath };
  await app.page.getByRole("button", { name: "Settings", exact: true }).click();
  await app.page.getByRole("button", { name: "Providers", exact: true }).click();
  const kimi = app.page.getByRole("button", { name: "Configure Kimi Code" });
  await expect(kimi).toContainText("Sign in required", { timeout: 20_000 });
  await kimi.click();
  await app.page.locator(".provider-settings-editor").getByRole("button", { name: "Connect", exact: true }).click();
  const dialog = app.page.getByRole("dialog", { name: "Connect Kimi Code" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Connection flow complete", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(kimi).toContainText("Configured");
  const loginEvents = await wireEvents(wirePath);
  const login = loginEvents.filter(event => event.kind === "login");
  expect(login).toEqual([expect.objectContaining({ args: ["acp", "--login"], tty: true })]);
  const priorInitialize = loginEvents.find(event => event.kind === "rpc" && event.method === "initialize");
  expect(priorInitialize).toMatchObject({ terminalAuth: true, signedIn: false });
  expect(priorInitialize?.pid).not.toBe(login[0]?.pid);
  await app.page.getByRole("button", { name: "Workspace", exact: true }).click();
  await completeTurn(app, "Synthetic Kimi first send");
  await completeTurn(app, "Synthetic Kimi second send");
  await expect.poll(() => durableCounts(app, conversationId)).toEqual({ completed: 2, owners: 0 });
  await app.restart();
  await expect(app.page.getByText("Synthetic Kimi first send", { exact: true })).toBeVisible();
  await expect(app.page.getByText("Synthetic Kimi second send", { exact: true })).toBeVisible();
  await completeTurn(app, "Synthetic Kimi send after restart");
  await expect.poll(() => durableCounts(app, conversationId)).toEqual({ completed: 3, owners: 0 });
  const events = await wireEvents(wirePath);
  const initialized = events.filter(event => event.kind === "rpc" && event.method === "initialize");
  expect(initialized.filter(event => event.signedIn === true)).toHaveLength(3);
  expect(new Set(initialized.map(event => event.pid)).size).toBe(initialized.length);
  expect(events.filter(event => event.method === "authenticate")).toEqual([]);
  expect(events.filter(event => event.method === "session/prompt")).toHaveLength(3);
  expect(events.filter(event => event.kind === "login")).toHaveLength(1);
  await expect.poll(() => [...initialized, ...login].every(event => !executableProcessExists(event.pid))).toBe(true);
  expect(app.rendererErrors).toEqual([]);
});
