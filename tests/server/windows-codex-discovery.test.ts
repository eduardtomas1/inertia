import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { providerEnvironment } from "../../src/server/environment";
import { detectProvider, ProviderManager } from "../../src/server/providers";
import {
  portableFixtureRoot,
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";

const WINDOWS_ENVIRONMENT_KEYS = [
  "APPDATA",
  "BUN_INSTALL",
  "CODEX_HOME",
  "CODEX_INSTALL_DIR",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "PNPM_HOME",
  "USERPROFILE",
  "VOLTA_HOME",
] as const;

describe.skipIf(process.platform !== "win32").sequential("native Windows Codex discovery", () => {
  const roots: string[] = [];
  const originalEnvironment = Object.fromEntries(WINDOWS_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));

  function root(label: string): string {
    const value = portableFixtureRoot(`windows Codex ${label}`);
    roots.push(value);
    return value;
  }

  function restoreEnvironment(): void {
    for (const key of WINDOWS_ENVIRONMENT_KEYS) {
      const value = originalEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  function codexProgram(version: string, text = "Windows shim response"): string {
    return `
const readline = require("node:readline");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex ${version}"); process.exit(0); }
if (args[0] === "login" && args[1] === "status") { console.log("Logged in using ChatGPT"); process.exit(0); }
if (args[0] === "app-server" && args[1] === "--help") { console.log("codex app-server - Run the app server"); process.exit(0); }
if (args.length !== 1 || args[0] !== "app-server") { console.error("unexpected invocation"); process.exit(2); }
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const threadId = "77777777-7777-4777-8777-777777777777";
const turnId = "windows-turn";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "windows-fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "model/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/rateLimits/read") return send({ id: message.id, result: { rateLimits: null } });
  if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: threadId }, model: "fixture" } });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
    send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "answer", delta: ${JSON.stringify(text)} } });
    return send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
  }
});
`;
  }

  function batchCodex(directory: string, version: string, text?: string): string {
    mkdirSync(directory, { recursive: true });
    const program = join(directory, "codex-fixture.cjs");
    writeFileSync(program, codexProgram(version, text), "utf8");
    const command = join(directory, "codex.cmd");
    // Real npm shims resolve their JavaScript entrypoint relative to the shim.
    // Keeping the Unicode path out of the batch file itself also avoids cmd.exe
    // decoding UTF-8 source text through the machine's legacy code page.
    writeFileSync(command, `@echo off\r\n"${process.execPath}" "%~dp0codex-fixture.cjs" %*\r\n`, "utf8");
    return command;
  }

  function nativeCodex(directory: string, cwd: string): string {
    mkdirSync(directory, { recursive: true });
    const command = join(directory, "codex.exe");
    copyFileSync(process.execPath, command);
    writeNodeSubcommand(cwd, "login", `console.log("Logged in using ChatGPT");`);
    writeNodeSubcommand(cwd, "app-server", `
const args = process.argv.slice(2);
if (args[0] === "--help") { console.log("codex app-server - Run the app server"); process.exit(0); }
process.stdin.resume();
`);
    return command;
  }

  afterEach(async () => {
    restoreEnvironment();
    await providerEnvironment(true);
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  it("finds the official standalone native executable with a minimal PATH", async () => {
    const home = root("official standalone");
    const official = join(home, ".codex", "packages", "standalone", "current", "bin");
    const executable = await realpath(nativeCodex(official, home));
    process.env.USERPROFILE = home;
    process.env.LOCALAPPDATA = join(home, "AppData", "Local");
    process.env.APPDATA = join(home, "AppData", "Roaming");
    process.env.PATH = join(home, "empty");
    process.env.PATHEXT = ".eXe;.CmD;.BaT";

    const detection = await detectProvider("codex", { cwd: home, refreshEnvironment: true });
    expect(detection).toMatchObject({
      available: true,
      executable,
      installState: "installed",
      authState: "authenticated",
      canRun: true,
    });
  });

  it("discovers and runs an npm shim from a Unicode path with spaces and parentheses", async () => {
    const home = root("npm Unicode Ω (profile)");
    const npm = join(home, "AppData", "Roaming", "npm");
    const executable = await realpath(batchCodex(npm, "9.4.1", "Safe shim response"));
    process.env.USERPROFILE = home;
    process.env.LOCALAPPDATA = join(home, "AppData", "Local");
    process.env.APPDATA = join(home, "AppData", "Roaming");
    process.env.PATH = npm;
    process.env.PATHEXT = ".EXE;.CMD;.BAT";

    const manager = new ProviderManager();
    const detection = await manager.detect("codex", { cwd: home, refreshEnvironment: true });
    expect(detection).toMatchObject({ executable, version: "9.4.1", canRun: true });
    await expect(manager.run({
      providerId: "codex",
      conversationId: "windows-shim",
      cwd: home,
      prompt: "Reply safely",
      interactionMode: "build",
      access: "supervised",
    })).resolves.toMatchObject({ status: "completed", text: "Safe shim response" });
    await manager.disposeAll();
  });

  it("continues after broken candidates and selects the newest valid install across PATH", async () => {
    const home = root("multiple versions");
    const broken = join(home, "broken");
    const older = join(home, "older");
    const newest = join(home, "newest");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "codex.exe"), "not a native executable", "utf8");
    batchCodex(older, "1.8.0");
    const expected = await realpath(batchCodex(newest, "3.2.1"));
    process.env.USERPROFILE = home;
    process.env.LOCALAPPDATA = join(home, "AppData", "Local");
    process.env.APPDATA = join(home, "AppData", "Roaming");
    process.env.PATH = [broken, older, newest].join(delimiter);
    process.env.PATHEXT = ".EXE;.CMD;.BAT";

    await expect(detectProvider("codex", { cwd: home, refreshEnvironment: true })).resolves.toMatchObject({
      executable: expected,
      version: "3.2.1",
      canRun: true,
    });
  });

  it("honors a manual binary override instead of a newer automatically discoverable install", async () => {
    const home = root("manual override");
    const automatic = join(home, "automatic");
    const manual = join(home, "manual");
    batchCodex(automatic, "8.0.0");
    const expected = await realpath(batchCodex(manual, "2.5.0"));
    process.env.PATH = automatic;
    process.env.PATHEXT = ".EXE;.CMD;.BAT";

    const manager = new ProviderManager({ commands: { codex: expected } });
    await expect(manager.detect("codex", { cwd: home, refreshEnvironment: true })).resolves.toMatchObject({
      executable: expected,
      version: "2.5.0",
      canRun: true,
    });
  });
});
