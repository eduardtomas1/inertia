// @inertia-e2e-resource isolated
import { expect, test, type Locator } from "@playwright/test";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

import { executableProcessExists } from "../helpers/executable-process";
import { writeNodeClaudeExecutable, writeNodeFlagExecutable } from "../helpers/portable-provider-fixture";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

type ProviderKey = "claude" | "codex" | "cursor" | "kimi" | "opencode" | "antigravity";

interface WireEvent {
  provider: ProviderKey;
  pid: number;
  kind: string;
  data?: string;
  value?: string;
  provider_choice?: string;
  method?: string;
}

const CANONICAL_ENTER = process.platform === "win32" ? "\r\n" : "\n";

const CODES: Readonly<Record<ProviderKey, string>> = {
  claude: "synthetic-claude-code#fixture-state",
  codex: "synthetic-codex-callback-code",
  cursor: "synthetic-cursor-approval",
  kimi: "synthetic-kimi-approval",
  opencode: "synthetic-opencode-code#fixture-state",
  antigravity: "4/synthetic-antigravity-code",
};

function fakePrelude(provider: ProviderKey, state: string): string {
  return `
const fs = require("node:fs");
const path = require("node:path");
const STATE = ${JSON.stringify(state)};
const PROVIDER = ${JSON.stringify(provider)};
const EXPECTED = ${JSON.stringify(CODES[provider])};
const args = process.argv.slice(2);
const record = (event) => fs.appendFileSync(path.join(STATE, "wire.jsonl"), JSON.stringify({ provider: PROVIDER, pid: process.pid, ...event }) + "\\n");
const marker = (name) => path.join(STATE, PROVIDER + "-" + name);
const signedIn = () => fs.existsSync(marker("signed-in"));
const signIn = () => fs.writeFileSync(marker("signed-in"), "synthetic-account-only");
const write = (text) => new Promise((resolve) => process.stdout.write(text, resolve));
const finish = async (text, code) => { await write(text); process.exit(code); };
const recordCanonicalInput = () => process.stdin.on("data", (chunk) => record({ kind: "stdin", data: chunk.toString("utf8") }));
const awaitBrowserDecision = (onDecision) => {
  const timer = setInterval(() => {
    let decision;
    try { decision = fs.readFileSync(marker("browser-decision"), "utf8"); } catch { return; }
    fs.rmSync(marker("browser-decision"));
    clearInterval(timer);
    onDecision(decision);
  }, 50);
};
const keys = (onToken, bracketed) => {
  process.stdin.setRawMode(true);
  if (bracketed) process.stdout.write("\\x1b[?2004h");
  let buffer = "";
  const onData = (chunk) => {
    const text = chunk.toString("utf8");
    record({ kind: "stdin", data: text });
    buffer += text;
    while (buffer) {
      let token = null;
      if (buffer[0] === "\\x1b") {
        const match = /^\\x1b\\[([0-9;]*)([~A-Za-z])/.exec(buffer);
        if (!match) { if (buffer.length < 8) return; buffer = buffer.slice(1); continue; }
        buffer = buffer.slice(match[0].length);
        token = match[2] === "A" ? "up" : match[2] === "B" ? "down" : null;
      } else {
        const character = buffer[0];
        buffer = buffer.slice(1);
        token = character === "\\r" || character === "\\n" ? "enter"
          : character === "\\x03" ? "interrupt"
          : character === "\\x7f" || character === "\\b" ? "backspace"
          : character >= " " ? character : null;
      }
      if (token === "interrupt") {
        record({ kind: "interrupt" });
        process.stdout.write("^C\\r\\n", () => process.exit(130));
        return;
      }
      if (token && onToken(token) === false) {
        process.stdin.off("data", onData);
        if (bracketed) process.stdout.write("\\x1b[?2004l");
        return;
      }
    }
  };
  process.stdin.on("data", onData);
};
const readCode = (label, bracketed) => new Promise((resolve) => {
  process.stdout.write(label);
  let value = "";
  keys((token) => {
    if (token === "enter") {
      process.stdout.write("\\r\\n");
      record({ kind: "submit", value });
      resolve(value);
      return false;
    }
    if (token === "backspace") {
      if (value) { value = value.slice(0, -1); process.stdout.write("\\b \\b"); }
      return true;
    }
    if (token.length === 1) { value += token; process.stdout.write(token); }
    return true;
  }, bracketed);
});
const select = (label, options, searchable) => new Promise((resolve) => {
  let search = "";
  let index = 0;
  const visible = () => options.filter(([, name]) => name.toLowerCase().includes(search.toLowerCase()));
  const render = () => {
    const current = visible()[index];
    process.stdout.write("\\r\\x1b[2K│  " + (searchable ? "Search: " + search + "  " : "") + "● " + (current ? current[1] : "No matches"));
  };
  process.stdout.write("◆  " + label + "\\r\\n");
  render();
  keys((token) => {
    const choices = visible();
    if (token === "enter") {
      const choice = choices[index];
      if (!choice) return true;
      process.stdout.write("\\r\\n│\\r\\n◇  " + label + ": " + choice[1] + "\\r\\n");
      resolve(choice[0]);
      return false;
    }
    if (token === "up") index = (index + choices.length - 1) % Math.max(1, choices.length);
    else if (token === "down") index = (index + 1) % Math.max(1, choices.length);
    else if (token === "backspace" && searchable) { search = search.slice(0, -1); index = 0; }
    else if (token.length === 1 && searchable) { search += token; index = 0; }
    render();
    return true;
  }, false);
});
`;
}

function claudeFake(state: string): string {
  return `${fakePrelude("claude", state)}
if (args[0] === "--version") { console.log("2.1.0 (Claude Code)"); process.exit(0); }
if (args.join(" ") === "auth status --json") {
  const ok = signedIn();
  console.log(JSON.stringify(ok
    ? { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }
    : { loggedIn: false, authMethod: "none", apiProvider: "firstParty" }));
  process.exit(ok ? 0 : 1);
}
if (args.join(" ") === "auth login") {
  record({ kind: "login", tty: process.stdin.isTTY === true });
  (async () => {
    await write("Opening browser to sign in…\\r\\n");
    await write("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=fixture&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=fixture-challenge&code_challenge_method=S256&state=fixture-state\\r\\n\\r\\n");
    const code = await readCode("Paste code here if prompted > ", true);
    if (code === EXPECTED) { signIn(); await finish("Login successful.\\r\\n", 0); }
    await finish("OAuth error: Invalid code. Run claude auth login to try again.\\r\\n", 1);
  })();
  return;
}
record({ kind: "unexpected", data: args.join(" ") });
process.exit(1);
`;
}

function codexFake(state: string): string {
  return `${fakePrelude("codex", state)}
if (args[0] === "status") {
  if (signedIn()) { console.log("Logged in using ChatGPT"); process.exit(0); }
  console.log("Not logged in");
  process.exit(1);
}
if (args.length === 0) {
  record({ kind: "login", tty: process.stdin.isTTY === true });
  recordCanonicalInput();
  const server = require("node:http").createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/auth/callback") { response.writeHead(404); response.end(); return; }
    const accepted = url.searchParams.get("code") === EXPECTED && url.searchParams.get("state") === "fixture-state";
    record({ kind: "callback", value: accepted ? "accepted" : "rejected" });
    response.writeHead(accepted ? 200 : 400, { "content-type": "text/plain" });
    response.end(accepted ? "Signed in to Codex." : "Sign-in failed.");
    server.close();
    if (accepted) { signIn(); void finish("Successfully logged in\\r\\n", 0); }
    else void finish("Error logging in: token exchange failed\\r\\n", 1);
  });
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    fs.writeFileSync(marker("callback-port"), String(port));
    void write("Starting local login server on http://localhost:" + port + ".\\r\\nIf your browser did not open, navigate to this URL to authenticate:\\r\\n\\r\\nhttps://auth.openai.com/oauth/authorize?response_type=code&client_id=fixture&redirect_uri=http%3A%2F%2Flocalhost%3A" + port + "%2Fauth%2Fcallback&scope=openid+profile+email+offline_access&state=fixture-state\\r\\n");
  });
  return;
}
record({ kind: "unexpected", data: args.join(" ") });
process.exit(1);
`;
}

function cursorFake(state: string): string {
  return `${fakePrelude("cursor", state)}
if (args[0] === "--version") { console.log("2025.09.18-7ae6800"); process.exit(0); }
if (args[0] === "acp" && args[1] === "--help") { console.log("Usage: cursor-agent acp [options]\\n\\nStart the Cursor Agent Client Protocol (ACP) server"); process.exit(0); }
if (args[0] === "status") {
  if (signedIn()) { console.log("Logged in as synthetic@example.com"); process.exit(0); }
  console.log("Not logged in");
  process.exit(1);
}
if (args[0] === "login") {
  record({ kind: "login", tty: process.stdin.isTTY === true });
  recordCanonicalInput();
  void write("\\r\\nLogging in...\\r\\n\\r\\nOpen the following link to authenticate:\\r\\nhttps://cursor.com/loginDeepControl?challenge=fixture-challenge&uuid=fixture-uuid&mode=login\\r\\n\\r\\nWaiting for browser authentication...\\r\\n");
  awaitBrowserDecision((decision) => {
    if (decision === EXPECTED) { signIn(); void finish("\\r\\nLogin successful!\\r\\n", 0); }
    else void finish("\\r\\nLogin failed: the browser request was denied.\\r\\n", 1);
  });
  return;
}
record({ kind: "unexpected", data: args.join(" ") });
process.exit(1);
`;
}

function kimiFake(state: string): string {
  return `${fakePrelude("kimi", state)}
if (args[0] === "--version") { console.log("kimi 0.41.0"); process.exit(0); }
if (args[0] === "acp" && args[1] === "--help") { console.log("Usage: kimi acp - Agent Client Protocol"); process.exit(0); }
if (args[0] === "provider" && args[1] === "list") {
  console.log(signedIn() ? JSON.stringify({ providers: { "kimi-code": {} } }) : "Not logged in");
  process.exit(signedIn() ? 0 : 1);
}
if (args.join(" ") === "acp --login") {
  record({ kind: "login", tty: process.stdin.isTTY === true });
  recordCanonicalInput();
  void write("Starting Kimi Code device authorization...\\r\\nOpen https://www.kimi.com/code/authorize_device?user_code=KIMI-2468 and confirm the code KIMI-2468.\\r\\nWaiting for authorization...\\r\\n");
  awaitBrowserDecision((decision) => {
    if (decision === EXPECTED) { signIn(); void finish("Logged in to Kimi Code.\\r\\n", 0); }
    else void finish("Authorization was denied. Run the login again to retry.\\r\\n", 1);
  });
  return;
}
if (args.join(" ") !== "acp") { record({ kind: "unexpected", data: args.join(" ") }); process.exit(1); }
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: {
    protocolVersion: 1, agentInfo: { name: "Kimi Code CLI", version: "0.41.0" },
    agentCapabilities: { sessionCapabilities: { resume: {} }, mcpCapabilities: { http: true } },
    authMethods: [{ id: "login", name: "Kimi login", type: "terminal", args: ["--login"], env: {} }],
  } });
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Authentication required" } });
});
`;
}

function openCodeFake(state: string): string {
  return `${fakePrelude("opencode", state)}
const VERSION = "1.18.10";
if (args[0] === "--version") { console.log(VERSION); process.exit(0); }
if (args[0] === "serve" && args[1] === "--help") {
  console.log("opencode serve\\n\\nstarts a headless opencode server\\n\\nOptions:\\n  --port      port to listen on\\n  --hostname  hostname to listen on\\n  --pure      run without external plugins");
  process.exit(0);
}
if (args[0] === "serve") {
  const server = require("node:http").createServer((request, response) => {
    request.resume();
    const url = new URL(request.url, "http://127.0.0.1");
    const json = (value) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (url.pathname === "/global/health") return json({ healthy: true, version: VERSION });
    if (url.pathname === "/provider") return json({ all: [], default: {}, connected: [] });
    if (url.pathname === "/agent") return json([]);
    response.writeHead(404);
    response.end();
  });
  server.listen(0, "127.0.0.1", async () => {
    if (!args.includes("--pure")) {
      const plugins = path.join(process.cwd(), ".opencode", "plugins");
      for (const file of fs.existsSync(plugins) ? fs.readdirSync(plugins) : []) {
        if (!file.endsWith(".js")) continue;
        const copy = path.join(STATE, "opencode-plugin-" + process.pid + "-" + file.replace(/\\.js$/u, ".mjs"));
        fs.copyFileSync(path.join(plugins, file), copy);
        await import(require("node:url").pathToFileURL(copy).href);
      }
    }
    process.stdout.write("opencode server listening on http://127.0.0.1:" + server.address().port + "\\n");
  });
  return;
}
if (args.join(" ") === "auth list") {
  console.log(signedIn()
    ? "┌  Credentials ~/.local/share/opencode/auth.json\\n│\\n●  Anthropic oauth\\n│\\n└  1 credentials"
    : "┌  Credentials ~/.local/share/opencode/auth.json\\n│\\n└  0 credentials");
  process.exit(0);
}
if (args.join(" ") === "auth login") {
  record({ kind: "login", tty: process.stdin.isTTY === true });
  (async () => {
    await write("\\r\\n┌  Add credential\\r\\n│\\r\\n");
    const providerChoice = await select("Select provider", [["anthropic", "Anthropic"], ["openai", "OpenAI"], ["google", "Google"]], true);
    const method = await select("Login method", [["claude-pro-max", "Claude Pro/Max"], ["console", "Create an API Key"], ["api-key", "Manually enter API Key"]], false);
    record({ kind: "selection", provider_choice: providerChoice, method });
    if (providerChoice !== "anthropic" || method !== "claude-pro-max") await finish("└  Unsupported synthetic selection\\r\\n", 1);
    await write("│\\r\\n●  Go to: https://claude.ai/oauth/authorize?code=true&client_id=fixture&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&state=fixture-state\\r\\n│\\r\\n");
    const code = await readCode("◆  Paste the authorization code here: ", false);
    if (code === EXPECTED) { signIn(); await finish("└  Login successful\\r\\n", 0); }
    await finish("└  Failed to authorize\\r\\n", 1);
  })();
  return;
}
record({ kind: "unexpected", data: args.join(" ") });
process.exit(1);
`;
}

function antigravityFake(state: string): string {
  return `${fakePrelude("antigravity", state)}
if (args[0] === "--version") { console.log("1.2.3"); process.exit(0); }
if (args.length === 0) {
  record({ kind: "login", tty: process.stdin.isTTY === true });
  (async () => {
    await write("Antigravity CLI 1.2.3\\r\\n\\r\\nYou are not signed in. Open this URL, approve access, then paste the authorization code:\\r\\nhttps://accounts.google.com/o/oauth2/v2/auth?client_id=fixture&redirect_uri=https%3A%2F%2Fantigravity.google%2Fauth%2Fcode&response_type=code&scope=openid%20email&state=fixture-state\\r\\n\\r\\n");
    for (;;) {
      const code = await readCode("Authorization code: ", true);
      if (code === EXPECTED) break;
      await write("Invalid authorization code. Try again.\\r\\n");
    }
    signIn();
    await write("Signed in as synthetic@example.com.\\r\\n\\r\\n");
    const command = await readCode("> ", true);
    await finish(command === "/quit" ? "Goodbye.\\r\\n" : "", command === "/quit" ? 0 : 1);
  })();
  return;
}
record({ kind: "unexpected", data: args.join(" ") });
process.exit(1);
`;
}

const metadataCodex = `
if (process.argv.slice(2)[0] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
setInterval(() => {}, 1_000);
`;

let app!: AppFixture;
let state = "";
const consumedLogins = new Map<ProviderKey, number>();
const loginLines = new Map<number, number>();

async function wire(): Promise<WireEvent[]> {
  const text = await readFile(join(state, "wire.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as WireEvent);
}

async function nextLoginPid(provider: ProviderKey): Promise<number> {
  const consumed = consumedLogins.get(provider) ?? 0;
  let pid = 0;
  let line = 0;
  await expect.poll(async () => {
    const logins = (await wire()).flatMap((event, index) =>
      event.provider === provider && event.kind === "login" ? [{ pid: event.pid, index }] : []);
    pid = logins[consumed]?.pid ?? 0;
    line = logins[consumed]?.index ?? 0;
    return pid;
  }, { timeout: 20_000 }).toBeGreaterThan(0);
  consumedLogins.set(provider, consumed + 1);
  loginLines.set(pid, line);
  return pid;
}

async function eventsFor(pid: number, kind: string): Promise<WireEvent[]> {
  return (await wire()).slice(loginLines.get(pid) ?? 0).filter((event) => event.pid === pid && event.kind === kind);
}

async function stdinFor(pid: number): Promise<string> {
  return (await eventsFor(pid, "stdin")).map((event) => event.data ?? "").join("");
}

async function openConnect(label: string, action: "Connect" | "Configure"): Promise<Locator> {
  const page = app.page;
  await page.getByRole("button", { name: `Configure ${label}`, exact: true }).click();
  await page.locator(".provider-settings-editor").getByRole("button", { name: action, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Connect ${label}` });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function expectTerminalFocused(dialog: Locator): Promise<void> {
  await expect(dialog.locator(".xterm-helper-textarea")).toBeFocused();
}

async function returnFromBrowser(dialog: Locator): Promise<void> {
  await app.electronApp.evaluate(({ app: electronApp, BrowserWindow }) => {
    if (process.platform === "darwin") electronApp.hide();
    else BrowserWindow.getAllWindows()[0]?.blur();
  });
  await app.electronApp.evaluate(({ app: electronApp, BrowserWindow }) => {
    if (process.platform === "darwin") {
      electronApp.show();
      electronApp.focus({ steal: true });
    } else {
      BrowserWindow.getAllWindows()[0]?.focus();
    }
  });
  await expectTerminalFocused(dialog);
  const [, height] = await app.page.evaluate(() => [window.innerWidth, window.innerHeight]);
  await app.page.mouse.click(6, height - 6);
  await expectTerminalFocused(dialog);
  await dialog.locator("#provider-auth-description").click();
  await expectTerminalFocused(dialog);
}

async function pasteFromClipboard(text: string): Promise<void> {
  await app.electronApp.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
  await app.page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
}

async function cancelWithInterrupt(
  dialog: Locator,
  pid: number,
  batchShimAsksToTerminate = false,
): Promise<void> {
  await expectTerminalFocused(dialog);
  await app.page.keyboard.press("Control+C");
  if (batchShimAsksToTerminate) {
    await expect(dialog).toContainText("Terminate batch job (Y/N)?");
    await expect.poll(() => executableProcessExists(pid)).toBe(false);
    await expectTerminalFocused(dialog);
    await app.page.keyboard.type("Y");
    await app.page.keyboard.press("Enter");
  }
  await expect(dialog.getByText("The provider ended the connection flow before it completed.").last()).toBeVisible();
  await expect.poll(() => executableProcessExists(pid)).toBe(false);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function closeWhileWaiting(dialog: Locator, pid: number): Promise<void> {
  await expectTerminalFocused(dialog);
  expect(executableProcessExists(pid)).toBe(true);
  await app.page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect.poll(() => executableProcessExists(pid), { timeout: 10_000 }).toBe(false);
}

async function expectRejected(dialog: Locator, pid: number, message: string): Promise<void> {
  await expect(dialog).toContainText(message);
  await expect(dialog.getByText("The provider ended the connection flow before it completed.").last()).toBeVisible();
  await expect.poll(() => executableProcessExists(pid)).toBe(false);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function expectCompleted(dialog: Locator, label: string, status: string): Promise<void> {
  await expect(dialog.getByText("Connection flow complete", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(app.page.getByRole("button", { name: `Configure ${label}`, exact: true })).toContainText(status, { timeout: 20_000 });
}

async function approveInBrowser(provider: "cursor" | "kimi", decision: string): Promise<void> {
  const target = join(state, `${provider}-browser-decision`);
  await writeFile(`${target}.tmp`, decision, "utf8");
  await rename(`${target}.tmp`, target);
}

async function codexBrowserCallback(code: string): Promise<number> {
  const port = await readFile(join(state, "codex-callback-port"), "utf8");
  const response = await fetch(`http://127.0.0.1:${port}/auth/callback?code=${encodeURIComponent(code)}&state=fixture-state`);
  return response.status;
}

test.beforeAll(async () => {
  const additionalEnvironment: Record<string, string> = {};
  app = await createAppFixture({
    name: "provider-auth-input",
    initialState: "conversation",
    additionalEnvironment,
    codexAppServerSource: metadataCodex,
    beforeLaunch: async ({ testDirectory, workspaceDirectory }) => {
      const bin = join(testDirectory, "provider-bin");
      const home = join(testDirectory, "provider-home");
      state = join(testDirectory, "provider-auth-state");
      await Promise.all([bin, home, state].map((path) => mkdir(path, { recursive: true })));
      writeNodeClaudeExecutable(bin, claudeFake(state));
      writeNodeFlagExecutable(bin, "cursor-agent", cursorFake(state));
      writeNodeFlagExecutable(bin, "kimi", kimiFake(state));
      writeNodeFlagExecutable(bin, "opencode", openCodeFake(state));
      writeNodeFlagExecutable(bin, "agy", antigravityFake(state));
      await writeFile(join(workspaceDirectory, "login"), codexFake(state), "utf8");
      const systemPaths = process.platform === "win32"
        ? [dirname(process.execPath), join(process.env.SystemRoot ?? "C:\\Windows", "System32")]
        : ["/usr/bin", "/bin"];
      Object.assign(additionalEnvironment, {
        PATH: [bin, ...systemPaths].join(delimiter), HOME: home, USERPROFILE: home,
        APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home,
        XDG_DATA_HOME: home, CODEX_HOME: join(home, ".codex"), KIMI_CODE_HOME: home,
        NVM_BIN: "", NVM_DIR: "",
      });
    },
  });
  await app.electronApp.evaluate(({ clipboard, shell }) => {
    Reflect.set(globalThis, "__inertiaAuthInputClipboard", clipboard.readText());
    const opened: string[] = [];
    Reflect.set(globalThis, "__inertiaAuthInputOpened", opened);
    Reflect.set(shell, "openExternal", async (url: string) => { opened.push(url); });
  });
  await app.page.getByRole("button", { name: "Settings", exact: true }).click();
  await app.page.getByRole("button", { name: "Providers", exact: true }).click();
});

test.afterAll(async () => {
  await app.electronApp.evaluate(({ clipboard }) =>
    clipboard.writeText(String(Reflect.get(globalThis, "__inertiaAuthInputClipboard") ?? "")));
  await app.close();
});

test("Claude sign-in accepts typing and a pasted code after returning from the browser", async () => {
  test.setTimeout(120_000);
  const row = app.page.getByRole("button", { name: "Configure Claude", exact: true });
  await expect(row).toContainText("Sign in required", { timeout: 30_000 });

  let dialog = await openConnect("Claude", "Connect");
  await expect(dialog).toContainText("Paste code here if prompted >");
  await cancelWithInterrupt(dialog, await nextLoginPid("claude"));

  dialog = await openConnect("Claude", "Connect");
  await expect(dialog).toContainText("Paste code here if prompted >");
  await closeWhileWaiting(dialog, await nextLoginPid("claude"));
  await expect(row).toContainText("Sign in required");

  dialog = await openConnect("Claude", "Connect");
  await expect(dialog).toContainText("Paste code here if prompted >");
  const rejected = await nextLoginPid("claude");
  await expectTerminalFocused(dialog);
  await app.page.keyboard.type("typed-wrong-code");
  await expect(dialog).toContainText("Paste code here if prompted > typed-wrong-code");
  await app.page.keyboard.press("Enter");
  await expectRejected(dialog, rejected, "OAuth error: Invalid code");
  expect((await eventsFor(rejected, "submit")).map((event) => event.value)).toEqual(["typed-wrong-code"]);

  dialog = await openConnect("Claude", "Connect");
  await expect(dialog.getByRole("status")).toContainText("Sign-in page opened in your browser");
  const accepted = await nextLoginPid("claude");
  await returnFromBrowser(dialog);
  await pasteFromClipboard(CODES.claude);
  await expect(dialog).toContainText(`Paste code here if prompted > ${CODES.claude}`);
  await app.page.keyboard.press("Enter");
  await expectCompleted(dialog, "Claude", "Connected");
  expect((await eventsFor(accepted, "submit")).map((event) => event.value)).toEqual([CODES.claude]);
  expect(await stdinFor(accepted)).toBe(`\x1b[200~${CODES.claude}\x1b[201~\r`);
  await expect.poll(() => executableProcessExists(accepted)).toBe(false);
  expect(await app.electronApp.evaluate(() =>
    (Reflect.get(globalThis, "__inertiaAuthInputOpened") as string[]).every((url) =>
      url.startsWith("https://claude.com/cai/oauth/authorize?")))).toBe(true);
});

test("Codex sign-in keeps terminal input live while its browser callback completes", async () => {
  test.setTimeout(120_000);
  const row = app.page.getByRole("button", { name: "Configure Codex", exact: true });
  await expect(row).toContainText("Sign in required", { timeout: 30_000 });

  let dialog = await openConnect("Codex", "Connect");
  await expect(dialog).toContainText("Starting local login server");
  await cancelWithInterrupt(dialog, await nextLoginPid("codex"));

  dialog = await openConnect("Codex", "Connect");
  await expect(dialog).toContainText("Starting local login server");
  await closeWhileWaiting(dialog, await nextLoginPid("codex"));

  dialog = await openConnect("Codex", "Connect");
  await expect(dialog).toContainText("navigate to this URL to authenticate");
  const rejected = await nextLoginPid("codex");
  await expectTerminalFocused(dialog);
  await app.page.keyboard.type("typed-probe");
  await app.page.keyboard.press("Enter");
  await expect.poll(() => stdinFor(rejected)).toBe(`typed-probe${CANONICAL_ENTER}`);
  expect(await codexBrowserCallback("wrong-callback-code")).toBe(400);
  await expectRejected(dialog, rejected, "Error logging in: token exchange failed");

  dialog = await openConnect("Codex", "Connect");
  await expect(dialog).toContainText("navigate to this URL to authenticate");
  const accepted = await nextLoginPid("codex");
  await returnFromBrowser(dialog);
  await pasteFromClipboard("pasted-probe");
  await app.page.keyboard.press("Enter");
  await expect.poll(() => stdinFor(accepted)).toBe(`pasted-probe${CANONICAL_ENTER}`);
  expect(await codexBrowserCallback(CODES.codex)).toBe(200);
  await expectCompleted(dialog, "Codex", "Connected");
  await expect.poll(() => executableProcessExists(accepted)).toBe(false);
});

for (const scenario of [
  { provider: "cursor" as const, label: "Cursor", prompt: "Waiting for browser authentication", denied: "Login failed: the browser request was denied.", status: "Connected" },
  { provider: "kimi" as const, label: "Kimi Code", prompt: "Waiting for authorization", denied: "Authorization was denied.", status: "Configured" },
]) {
  test(`${scenario.label} sign-in keeps terminal input live while its browser approval completes`, async () => {
    test.setTimeout(120_000);
    const row = app.page.getByRole("button", { name: `Configure ${scenario.label}`, exact: true });
    await expect(row).toContainText("Sign in required", { timeout: 30_000 });

    let dialog = await openConnect(scenario.label, "Connect");
    await expect(dialog).toContainText(scenario.prompt);
    await cancelWithInterrupt(dialog, await nextLoginPid(scenario.provider), process.platform === "win32");

    dialog = await openConnect(scenario.label, "Connect");
    await expect(dialog).toContainText(scenario.prompt);
    await closeWhileWaiting(dialog, await nextLoginPid(scenario.provider));

    dialog = await openConnect(scenario.label, "Connect");
    await expect(dialog).toContainText(scenario.prompt);
    const rejected = await nextLoginPid(scenario.provider);
    await expectTerminalFocused(dialog);
    await app.page.keyboard.type("typed-probe");
    await app.page.keyboard.press("Enter");
    await expect.poll(() => stdinFor(rejected)).toBe(`typed-probe${CANONICAL_ENTER}`);
    await approveInBrowser(scenario.provider, "denied");
    await expectRejected(dialog, rejected, scenario.denied);

    dialog = await openConnect(scenario.label, "Connect");
    await expect(dialog).toContainText(scenario.prompt);
    const accepted = await nextLoginPid(scenario.provider);
    await returnFromBrowser(dialog);
    await pasteFromClipboard("pasted-probe");
    await app.page.keyboard.press("Enter");
    await expect.poll(() => stdinFor(accepted)).toBe(`pasted-probe${CANONICAL_ENTER}`);
    await approveInBrowser(scenario.provider, CODES[scenario.provider]);
    await expectCompleted(dialog, scenario.label, scenario.status);
    await expect.poll(() => executableProcessExists(accepted)).toBe(false);
  });
}

test("OpenCode credential setup accepts menu keys, typing and a pasted code", async () => {
  test.setTimeout(150_000);
  const row = app.page.getByRole("button", { name: "Configure OpenCode", exact: true });
  await expect(app.page.locator(".provider-settings-rail")).toBeVisible();
  await row.click();
  await expect(app.page.locator(".provider-settings-editor").getByRole("button", { name: "Configure", exact: true }))
    .toBeEnabled({ timeout: 60_000 });

  let dialog = await openConnect("OpenCode", "Configure");
  await expect(dialog).toContainText("Select provider");
  await cancelWithInterrupt(dialog, await nextLoginPid("opencode"));

  dialog = await openConnect("OpenCode", "Configure");
  await expect(dialog).toContainText("Select provider");
  await closeWhileWaiting(dialog, await nextLoginPid("opencode"));

  const chooseClaudeProMax = async (target: Locator): Promise<void> => {
    await expect(target).toContainText("Select provider");
    await expectTerminalFocused(target);
    await app.page.keyboard.type("anth");
    await expect(target).toContainText("Search: anth  ● Anthropic");
    await app.page.keyboard.press("Enter");
    await expect(target).toContainText("● Claude Pro/Max");
    await app.page.keyboard.press("ArrowDown");
    await expect(target).toContainText("● Create an API Key");
    await app.page.keyboard.press("ArrowUp");
    await expect(target).toContainText("● Claude Pro/Max");
    await app.page.keyboard.press("Enter");
    await expect(target).toContainText("Paste the authorization code here:");
  };

  dialog = await openConnect("OpenCode", "Configure");
  const rejected = await nextLoginPid("opencode");
  await chooseClaudeProMax(dialog);
  await app.page.keyboard.type("typed-wrong-code");
  await app.page.keyboard.press("Enter");
  await expectRejected(dialog, rejected, "Failed to authorize");
  expect((await eventsFor(rejected, "selection"))[0]).toMatchObject({ provider_choice: "anthropic", method: "claude-pro-max" });
  expect((await eventsFor(rejected, "submit")).map((event) => event.value)).toEqual(["typed-wrong-code"]);

  dialog = await openConnect("OpenCode", "Configure");
  const accepted = await nextLoginPid("opencode");
  await chooseClaudeProMax(dialog);
  await returnFromBrowser(dialog);
  await pasteFromClipboard(CODES.opencode);
  await expect(dialog).toContainText(`Paste the authorization code here: ${CODES.opencode}`);
  await app.page.keyboard.press("Enter");
  await expectCompleted(dialog, "OpenCode", "Configured");
  expect((await eventsFor(accepted, "submit")).map((event) => event.value)).toEqual([CODES.opencode]);
  await expect.poll(() => executableProcessExists(accepted)).toBe(false);
});

test("Antigravity sign-in accepts a retry and a menu paste in its own prompt", async () => {
  test.setTimeout(120_000);
  const row = app.page.getByRole("button", { name: "Configure Antigravity", exact: true });
  await expect(row).toContainText("Antigravity checks your sign-in", { timeout: 30_000 });

  let dialog = await openConnect("Antigravity", "Connect");
  await expect(dialog).toContainText("Authorization code:");
  await cancelWithInterrupt(dialog, await nextLoginPid("antigravity"));

  dialog = await openConnect("Antigravity", "Connect");
  await expect(dialog).toContainText("Authorization code:");
  await closeWhileWaiting(dialog, await nextLoginPid("antigravity"));

  dialog = await openConnect("Antigravity", "Connect");
  await expect(dialog).toContainText("Authorization code:");
  const pid = await nextLoginPid("antigravity");
  await expectTerminalFocused(dialog);
  await app.page.keyboard.type("typed-wrong-code");
  await app.page.keyboard.press("Enter");
  await expect(dialog).toContainText("Invalid authorization code. Try again.");
  await returnFromBrowser(dialog);
  await app.electronApp.evaluate(({ clipboard }, value) => clipboard.writeText(value), CODES.antigravity);
  await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.paste());
  await expect(dialog).toContainText(`Authorization code: ${CODES.antigravity}`);
  await app.page.keyboard.press("Enter");
  await expect(dialog).toContainText("Signed in as synthetic@example.com.");
  await app.page.keyboard.type("/quit");
  await app.page.keyboard.press("Enter");
  await expect(dialog.getByText("Antigravity closed — your next turn will check sign-in", { exact: true })).toBeVisible();
  expect((await eventsFor(pid, "submit")).map((event) => event.value))
    .toEqual(["typed-wrong-code", CODES.antigravity, "/quit"]);
  await expect.poll(() => executableProcessExists(pid)).toBe(false);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toContainText("Antigravity checks your sign-in");
  expect(app.rendererErrors).toEqual([]);
});
