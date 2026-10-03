// @inertia-test-suite portable
import { win32 } from "node:path";
import { describe, expect, it } from "vitest";

import {
  resolveClaudeLaunchTarget,
  type ClaudeLaunchFileSystem,
} from "../../src/server/provider/claude-launch-target";
import { detectProvider } from "../../src/server/providers";

const NPM = "C:\\Users\\Calm Dev\\AppData\\Roaming\\npm";
const PACKAGE = `${NPM}\\node_modules\\@anthropic-ai\\claude-code`;
const MANIFEST = `${PACKAGE}\\package.json`;
const ENTRY = `${PACKAGE}\\cli.js`;

function fakeFileSystem(
  files: Record<string, string>,
  links: Record<string, string> = {},
): ClaudeLaunchFileSystem {
  const key = (path: string): string => win32.normalize(path).toLowerCase();
  const contents = new Map(Object.entries(files).map(([path, value]) => [key(path), value]));
  const realpaths = new Map(Object.entries(links).map(([path, value]) => [key(path), value]));
  return {
    readFile: (path) => {
      const value = contents.get(key(path));
      if (value === undefined) throw new Error("ENOENT");
      return Buffer.from(value, "utf8");
    },
    realpath: (path) => {
      const normalized = win32.normalize(path);
      const linked = realpaths.get(key(normalized));
      if (linked) return linked;
      if (contents.has(key(normalized)) || key(normalized) === key(PACKAGE)) return normalized;
      throw new Error("ENOENT");
    },
    fileSize: (path) => {
      const value = contents.get(key(path));
      return value === undefined ? null : Buffer.byteLength(value);
    },
  };
}

function manifest(bin: unknown, name = "@anthropic-ai/claude-code"): string {
  return JSON.stringify({ name, bin });
}

const resolve = (
  shim: string,
  fileSystem: ClaudeLaunchFileSystem,
  environment: NodeJS.ProcessEnv = {},
  electronExecutable?: string,
) => resolveClaudeLaunchTarget(shim, environment, {
  platform: "win32",
  fileSystem,
  ...(electronExecutable ? { electronExecutable } : {}),
});

describe("Claude Windows launch target", () => {
  it("runs an npm shim's package entry with the node.exe installed beside the shim", () => {
    const fileSystem = fakeFileSystem({
      [MANIFEST]: manifest({ claude: "cli.js" }),
      [ENTRY]: "entry",
      [`${NPM}\\node.exe`]: "node",
    });

    expect(resolve(`${NPM}\\claude.cmd`, fileSystem)).toEqual({
      ok: true,
      target: { command: `${NPM}\\node.exe`, scriptPrefix: [ENTRY] },
    });
  });

  it("accepts a string bin for the package-named shim and a batch extension", () => {
    const fileSystem = fakeFileSystem({
      [MANIFEST]: manifest("cli.js"),
      [ENTRY]: "entry",
      [`${NPM}\\node.exe`]: "node",
    });

    expect(resolve(`${NPM}\\claude-code.BAT`, fileSystem)).toMatchObject({
      ok: true,
      target: { scriptPrefix: [ENTRY] },
    });
    expect(resolve(`${NPM}\\claude.cmd`, fileSystem)).toMatchObject({ ok: false });
  });

  it("falls back to node.exe from the sanitized provider PATH but never to Electron", () => {
    const nodeDirectory = "C:\\Program Files\\nodejs";
    const electron = "C:\\Program Files\\Inertia\\node.exe";
    const fileSystem = fakeFileSystem({
      [MANIFEST]: manifest({ claude: "cli.js" }),
      [ENTRY]: "entry",
      [electron]: "electron",
      [`${nodeDirectory}\\node.exe`]: "node",
    });
    const environment = { Path: `relative\\bin;C:\\Program Files\\Inertia;${nodeDirectory}` };

    expect(resolve(`${NPM}\\claude.cmd`, fileSystem, environment, electron)).toEqual({
      ok: true,
      target: { command: `${nodeDirectory}\\node.exe`, scriptPrefix: [ENTRY] },
    });
  });

  it("reports a missing Node.js runtime instead of guessing one", () => {
    const fileSystem = fakeFileSystem({
      [MANIFEST]: manifest({ claude: "cli.js" }),
      [ENTRY]: "entry",
    });

    expect(resolve(`${NPM}\\claude.cmd`, fileSystem, { PATH: "C:\\Windows\\System32" })).toEqual({
      ok: false,
      reason: expect.stringContaining("no Node.js runtime was found"),
    });
  });

  it("launches a native executable named by the package bin directly", () => {
    const nativeEntry = `${PACKAGE}\\bin\\claude.exe`;
    const fileSystem = fakeFileSystem({
      [MANIFEST]: manifest({ claude: "bin/claude.exe" }),
      [nativeEntry]: "native",
    });

    expect(resolve(`${NPM}\\claude.cmd`, fileSystem)).toEqual({
      ok: true,
      target: { command: nativeEntry, scriptPrefix: [] },
    });
  });

  it.each([
    ["an entry junction outside the package", { claude: "cli.js" }, { [ENTRY]: "C:\\Elsewhere\\cli.js" }],
    ["a parent-relative entry", { claude: "..\\..\\evil.js" }, {}],
    ["an absolute entry", { claude: "C:\\Elsewhere\\cli.js" }, {}],
    ["an unsupported entry type", { claude: "cli.ps1" }, {}],
    ["a missing bin for the shim", { other: "cli.js" }, {}],
  ])("rejects %s", (_label, bin, links) => {
    const fileSystem = fakeFileSystem({
      [MANIFEST]: manifest(bin),
      [ENTRY]: "entry",
      [`${PACKAGE}\\cli.ps1`]: "script",
      [`${NPM}\\evil.js`]: "evil",
      ["C:\\Elsewhere\\cli.js"]: "outside",
      [`${NPM}\\node.exe`]: "node",
    }, links);

    expect(resolve(`${NPM}\\claude.cmd`, fileSystem)).toEqual({
      ok: false,
      reason: expect.stringContaining("cannot launch safely"),
    });
  });

  it.each([
    ["an oversize manifest", JSON.stringify({ name: "@anthropic-ai/claude-code", bin: { claude: "cli.js" }, padding: "x".repeat(300 * 1024) })],
    ["a malformed manifest", "{not json"],
    ["a different package", manifest({ claude: "cli.js" }, "claude-code-impostor")],
  ])("rejects %s", (_label, content) => {
    const fileSystem = fakeFileSystem({
      [MANIFEST]: content,
      [ENTRY]: "entry",
      [`${NPM}\\node.exe`]: "node",
    });

    expect(resolve(`${NPM}\\claude.cmd`, fileSystem)).toMatchObject({ ok: false });
  });

  it.each([
    ["pnpm", "C:\\Users\\Calm Dev\\AppData\\Local\\pnpm\\claude.cmd"],
    ["yarn", "C:\\Users\\Calm Dev\\AppData\\Local\\Yarn\\bin\\claude.cmd"],
  ])("reports a %s shim without an adjacent npm package as not launchable", (_manager, shim) => {
    expect(resolve(shim, fakeFileSystem({}))).toMatchObject({ ok: false });
  });

  it("leaves a darwin .cmd executable unchanged", () => {
    const executable = "/opt/homebrew/bin/claude.cmd";
    expect(resolveClaudeLaunchTarget(executable, {}, { platform: "darwin", fileSystem: fakeFileSystem({}) })).toEqual({
      ok: true,
      target: { command: executable, scriptPrefix: [] },
    });
  });
});

describe("Claude Windows shim discovery", () => {
  const shim = `${NPM}\\claude.cmd`;
  const detect = (signedIn: boolean, fileSystem: ClaudeLaunchFileSystem) => detectProvider(
    "claude",
    { command: shim, cwd: process.cwd() },
    {
      executableCandidates: async () => [shim],
      probeProcess: async (_executable, args) => ({
        started: true,
        timedOut: false,
        cleanupConfirmed: true,
        exitCode: args[0] === "--version" || signedIn ? 0 : 1,
        output: args[0] === "--version"
          ? "2.1.0 (Claude Code)"
          : JSON.stringify({ loggedIn: signedIn }),
      }),
      claudeLaunchTarget: { platform: "win32", fileSystem },
    },
  );
  const npmLayout = (): ClaudeLaunchFileSystem => fakeFileSystem({
    [MANIFEST]: manifest({ claude: "cli.js" }),
    [ENTRY]: "entry",
    [`${NPM}\\node.exe`]: "node",
  });

  it("keeps sign-in available for any shim while signed out", async () => {
    await expect(detect(false, fakeFileSystem({}))).resolves.toMatchObject({
      installState: "installed",
      authState: "unauthenticated",
      canRun: false,
      statusMessage: "Sign in required",
    });
  });

  it("runs a signed-in npm shim whose package entry resolves", async () => {
    await expect(detect(true, npmLayout())).resolves.toMatchObject({
      authState: "authenticated",
      canRun: true,
      statusMessage: "Connected",
    });
  });

  it("reports a signed-in shim it cannot launch as not runnable with the reason", async () => {
    await expect(detect(true, fakeFileSystem({}))).resolves.toMatchObject({
      installState: "installed",
      authState: "authenticated",
      canRun: false,
      statusMessage: expect.stringContaining("cannot launch safely"),
    });
  });
});
