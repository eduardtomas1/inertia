// @inertia-test-suite portable
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUTOCAD_BRIDGE_PS1,
  SKETCHUP_LOADER_RB,
  SKETCHUP_MAIN_RB,
} from "../../src/server/cad/bridge-sources";
import {
  type AutoCadRunner,
  BRIDGE_VERSION,
  CadError,
  createAutoCadHost,
  createSketchUpHost,
  HOST_UNREADABLE,
  sketchUpSettingsBase,
} from "../../src/server/cad/cad-hosts";
import { RestrictedCliError } from "../../src/server/restricted-cli-runner";
import { removeTemporaryDirectory } from "../helpers/temporary-directory";

const roots: string[] = [];
const servers: Server[] = [];
const TOKEN = "t0k3n-".repeat(6);
const DEAD_PID = 2 ** 30;
const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(roots.splice(0).map(removeTemporaryDirectory));
});

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function rejection(promise: Promise<unknown>): Promise<CadError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(CadError);
  return error as CadError;
}

interface BridgeConnection {
  socket: Socket;
  lines: Array<Record<string, unknown>>;
  /** The client hung up (its FIN arrived) before the bridge ended the socket. */
  clientEnded: boolean;
  closed: Promise<void>;
}

type BridgeHandler = (request: Record<string, unknown>, socket: Socket) => void;

async function startBridge(handler: BridgeHandler): Promise<{ port: number; connections: BridgeConnection[] }> {
  const connections: BridgeConnection[] = [];
  const server = createServer((socket) => {
    let buffered = "";
    let resolveClosed!: () => void;
    const connection: BridgeConnection = {
      socket,
      lines: [],
      clientEnded: false,
      closed: new Promise<void>((resolve) => {
        resolveClosed = resolve;
      }),
    };
    connections.push(connection);
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    socket.on("end", () => {
      connection.clientEnded = true;
    });
    socket.on("close", () => resolveClosed());
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      let end = buffered.indexOf("\n");
      while (end >= 0) {
        const request = JSON.parse(buffered.slice(0, end)) as Record<string, unknown>;
        buffered = buffered.slice(end + 1);
        connection.lines.push(request);
        handler(request, socket);
        end = buffered.indexOf("\n");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The test bridge has no port.");
  return { port: address.port, connections };
}

const answer = (socket: Socket, request: Record<string, unknown>, body: Record<string, unknown>): void => {
  socket.write(`${JSON.stringify({ v: 1, id: request.id, ...body })}\n`);
};

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("No port.");
  return address.port;
}

async function writeDiscovery(home: string, port: number, overrides: Record<string, unknown> = {}): Promise<string> {
  const folder = join(home, ".inertia-cad", "hosts");
  await mkdir(folder, { recursive: true });
  const pid = typeof overrides.pid === "number" ? overrides.pid : process.pid;
  const file = join(folder, `sketchup-${pid}.json`);
  await writeFile(file, JSON.stringify({
    app: "sketchup", pid, port, token: TOKEN, bridgeVersion: BRIDGE_VERSION, appVersion: "25.0.571", ...overrides,
  }));
  return file;
}

const documentId = `skp:${process.pid}:1`;
const skpDocument = { documentId, app: "sketchup", name: "House.skp", path: null, modified: false, active: true };

async function sketchUp(handler: BridgeHandler, discovery: Record<string, unknown> = {}) {
  const home = await temporary("inertia-cad-home-");
  const bridge = await startBridge(handler);
  await writeDiscovery(home, bridge.port, discovery);
  return { home, bridge, host: createSketchUpHost(home, undefined) };
}

describe("SketchUp host requests", () => {
  it("sends one token-bearing request and returns the result", async () => {
    const { bridge, host } = await sketchUp((request, socket) => answer(socket, request, { ok: true, result: { items: [1] } }));
    expect(await host.call("query", { documentId, tag: "Walls" }, { documentId, timeoutMs: 2_000 })).toEqual({ items: [1] });
    expect(bridge.connections).toHaveLength(1);
    expect(bridge.connections[0]!.lines).toEqual([{
      v: 1,
      id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      token: TOKEN,
      method: "query",
      params: { documentId, tag: "Walls", deadlineAt: expect.any(Number) },
    }]);
  });

  it("tells the bridge when Inertia stops waiting, and nothing about a dialog", async () => {
    const { bridge, host } = await sketchUp((request, socket) => answer(socket, request, { ok: true, result: {} }));
    const before = Date.now();
    await host.call("apply", { documentId }, { documentId, timeoutMs: 600_000 });
    const after = Date.now();
    const params = bridge.connections[0]!.lines[0]!.params as Record<string, unknown>;
    // With no approval dialog there is no waiting process to watch.
    expect(params).not.toHaveProperty("parentPid");
    expect(params.deadlineAt).toBeGreaterThanOrEqual(before + 600_000);
    expect(params.deadlineAt).toBeLessThanOrEqual(after + 600_000);
  });

  it("sends info as its own bridge method", async () => {
    const { bridge, host } = await sketchUp((request, socket) => answer(socket, request, { ok: true, result: { units: "mm" } }));
    expect(await host.call("info", { documentId }, { documentId, timeoutMs: 2_000 })).toEqual({ units: "mm" });
    expect(bridge.connections[0]!.lines[0]).toMatchObject({ method: "info", params: { documentId } });
  });

  it("hangs up after the first answer line without waiting for the bridge to close", async () => {
    const { bridge, host } = await sketchUp((request, socket) => answer(socket, request, { ok: true, result: {} }));
    await host.call("selection", { documentId }, { documentId, timeoutMs: 2_000 });
    const connection = bridge.connections[0]!;
    await connection.closed;
    expect(connection.clientEnded).toBe(true);
  });

  it("uses a new connection for every request", async () => {
    const { bridge, host } = await sketchUp((request, socket) => answer(socket, request, { ok: true, result: {} }));
    await host.call("selection", { documentId }, { documentId, timeoutMs: 2_000 });
    await host.call("selection", { documentId }, { documentId, timeoutMs: 2_000 });
    expect(bridge.connections.map(({ lines }) => lines.length)).toEqual([1, 1]);
  });

  it("raises the bridge's own error code", async () => {
    const { host } = await sketchUp((request, socket) => answer(socket, request, {
      ok: false, error: { code: "STALE_TARGET", message: "Group 11 changed since the preview." },
    }));
    const error = await rejection(host.call("apply", { documentId }, { documentId, timeoutMs: 2_000 }));
    expect(error.code).toBe("STALE_TARGET");
    expect(error.message).toBe("Group 11 changed since the preview.");
  });

  it.each([
    { label: "not JSON", line: "this is not json" },
    { label: "the wrong shape", line: JSON.stringify({ result: 1 }) },
    { label: "an error without a string code", line: JSON.stringify({ ok: false, error: { code: 7, message: "x" } }) },
  ])("calls an answer that is $label HOST_UNREADABLE, since the request may have run", async ({ line }) => {
    const { host } = await sketchUp((_request, socket) => {
      socket.write(`${line}\n`);
    });
    const error = await rejection(host.call("apply", { documentId }, { documentId, timeoutMs: 2_000 }));
    expect(error).toMatchObject({ code: HOST_UNREADABLE, message: "The SketchUp bridge sent an unreadable answer." });
  });

  it("times out a bridge that accepts the request but never answers", async () => {
    const { bridge, host } = await sketchUp(() => undefined);
    const error = await rejection(host.call("apply", { documentId }, { documentId, timeoutMs: 150 }));
    expect(error.code).toBe("HOST_TIMEOUT");
    expect(bridge.connections[0]!.lines).toHaveLength(1);
    await bridge.connections[0]!.closed;
  });

  it("calls a bridge that hangs up without answering HOST_DISCONNECTED", async () => {
    const { host } = await sketchUp((_request, socket) => socket.end());
    expect((await rejection(host.call("apply", { documentId }, { documentId, timeoutMs: 2_000 }))).code)
      .toBe("HOST_DISCONNECTED");
  });

  it("calls a port nobody listens on HOST_OFFLINE", async () => {
    const home = await temporary("inertia-cad-home-");
    await writeDiscovery(home, await unusedPort());
    const host = createSketchUpHost(home, undefined);
    expect((await rejection(host.call("apply", { documentId }, { documentId, timeoutMs: 2_000 }))).code).toBe("HOST_OFFLINE");
  });

  it("treats a request cancelled before it is sent as CANCELLED, never as an offline SketchUp", async () => {
    const { bridge, host } = await sketchUp(() => undefined);
    const controller = new AbortController();
    controller.abort();
    const error = await rejection(host.call("apply", { documentId }, { documentId, timeoutMs: 2_000, signal: controller.signal }));
    expect(error.code).toBe("CANCELLED");
    expect(bridge.connections.flatMap(({ lines }) => lines)).toEqual([]);
  });

  it("treats a request cancelled after it is sent as HOST_TIMEOUT", async () => {
    const controller = new AbortController();
    const { host } = await sketchUp(() => controller.abort());
    const error = await rejection(host.call("apply", { documentId }, { documentId, timeoutMs: 5_000, signal: controller.signal }));
    expect(error.code).toBe("HOST_TIMEOUT");
    expect(error.message).toContain("cancelled");
  });
});

describe("SketchUp discovery", () => {
  it("routes skp:<pid>: document ids to that SketchUp process", async () => {
    const { host } = await sketchUp((request, socket) => answer(socket, request, { ok: true, result: { pid: "mine" } }));
    expect(host.owns(documentId)).toBe(true);
    expect(host.owns("acad:/drawings/Plan.dwg")).toBe(false);
    expect(await host.call("selection", {}, { documentId: `skp:${process.pid}:other`, timeoutMs: 2_000 })).toEqual({ pid: "mine" });
    const error = await rejection(host.call("selection", {}, { documentId: `skp:${DEAD_PID}:1`, timeoutMs: 2_000 }));
    expect(error.code).toBe("DOCUMENT_NOT_FOUND");
    expect((await rejection(host.call("selection", {}, { documentId: "skp:not-a-pid", timeoutMs: 2_000 }))).code)
      .toBe("DOCUMENT_NOT_FOUND");
  });

  it("deletes the discovery file of a process that is gone", async () => {
    const home = await temporary("inertia-cad-home-");
    const stale = await writeDiscovery(home, await unusedPort(), { pid: DEAD_PID });
    const host = createSketchUpHost(home, undefined);
    expect((await host.status()).documents).toEqual([]);
    await expect(readFile(stale, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores, but keeps, discovery files it cannot trust", async () => {
    const home = await temporary("inertia-cad-home-");
    const folder = join(home, ".inertia-cad", "hosts");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "sketchup-1.json"), JSON.stringify({ app: "sketchup", pid: DEAD_PID, port: 1, token: "short", bridgeVersion: "1" }));
    await writeFile(join(folder, "sketchup-2.json"), "{ not json");
    await writeFile(join(folder, "other-3.json"), JSON.stringify({ app: "sketchup", pid: DEAD_PID, port: 1, token: TOKEN, bridgeVersion: "1" }));
    const host = createSketchUpHost(home, undefined);
    expect((await rejection(host.call("selection", {}, { documentId: `skp:${DEAD_PID}:1`, timeoutMs: 1_000 }))).code)
      .toBe("DOCUMENT_NOT_FOUND");
    expect((await readdir(folder)).sort()).toEqual(["other-3.json", "sketchup-1.json", "sketchup-2.json"]);
  });
});

describe("SketchUp setup and status", () => {
  async function settings(versions: string[] = ["SketchUp 2025"]) {
    const home = await temporary("inertia-cad-home-");
    const base = await temporary("inertia-cad-settings-");
    for (const version of versions) await mkdir(join(base, version), { recursive: true });
    return { home, base, host: createSketchUpHost(home, base) };
  }

  const plugins = (base: string, version = "SketchUp 2025") => join(base, version, "SketchUp", "Plugins");

  it("reports not_installed without a settings folder", async () => {
    const home = await temporary("inertia-cad-home-");
    expect((await createSketchUpHost(home, undefined).status()).state).toBe("not_installed");
    const { host } = await settings([]);
    expect(await host.status()).toMatchObject({ app: "sketchup", state: "not_installed", documents: [] });
    expect(await host.setupPlan()).toEqual([]);
    expect((await rejection(host.setup())).code).toBe("NOT_INSTALLED");
  });

  it("reports setup_required until the extension is installed", async () => {
    const { base, host } = await settings();
    expect(await host.status()).toMatchObject({
      state: "setup_required",
      hint: expect.stringMatching(/inertia_cad_setup.*SketchUp 2025/u),
    });
    expect(await host.setupPlan()).toEqual([
      join(plugins(base), "inertia_cad_bridge.rb"),
      join(plugins(base), "inertia_cad_bridge", "main.rb"),
    ]);
  });

  it("refuses to install through a linked extension folder that points outside Plugins", async () => {
    const { base, host } = await settings();
    const outside = await temporary("inertia-cad-outside-");
    await writeFile(join(outside, "main.rb"), "not ours");
    await mkdir(plugins(base), { recursive: true });
    await symlink(outside, join(plugins(base), "inertia_cad_bridge"), process.platform === "win32" ? "junction" : "dir");
    const error = await rejection(host.setup());
    expect(error).toMatchObject({ code: "SETUP_FAILED", message: expect.stringContaining("is a link") });
    expect(await readFile(join(outside, "main.rb"), "utf8")).toBe("not ours");
  });

  // Windows needs a privilege to create file links; the folder case covers junctions there.
  it.skipIf(process.platform === "win32")("refuses to install through a linked loader file", async () => {
    const { base, host } = await settings();
    const outside = join(await temporary("inertia-cad-outside-"), "victim.rb");
    await writeFile(outside, "not ours");
    await mkdir(plugins(base), { recursive: true });
    await symlink(outside, join(plugins(base), "inertia_cad_bridge.rb"), "file");
    const error = await rejection(host.setup());
    expect(error).toMatchObject({ code: "SETUP_FAILED", message: expect.stringContaining("is a link") });
    expect(await readFile(outside, "utf8")).toBe("not ours");
  });

  it("installs the loader and main file into every SketchUp version folder", async () => {
    const { base, host } = await settings(["SketchUp 2024", "SketchUp 2025", "SketchUp 2025 beta", "SketchUp"]);
    await writeFile(join(base, "SketchUp 2023"), "a file, not a folder");
    expect(await host.setupPlan()).toEqual([
      join(plugins(base, "SketchUp 2024"), "inertia_cad_bridge.rb"),
      join(plugins(base, "SketchUp 2024"), "inertia_cad_bridge", "main.rb"),
      join(plugins(base, "SketchUp 2025"), "inertia_cad_bridge.rb"),
      join(plugins(base, "SketchUp 2025"), "inertia_cad_bridge", "main.rb"),
    ]);
    const result = await host.setup();
    expect(result).toEqual({
      app: "sketchup",
      installedFor: ["SketchUp 2024", "SketchUp 2025"],
      restartRequired: false,
      note: "Installed. It starts the next time SketchUp opens.",
    });
    for (const version of ["SketchUp 2024", "SketchUp 2025"]) {
      expect(await readFile(join(plugins(base, version), "inertia_cad_bridge.rb"), "utf8")).toBe(SKETCHUP_LOADER_RB);
      expect(await readFile(join(plugins(base, version), "inertia_cad_bridge", "main.rb"), "utf8")).toBe(SKETCHUP_MAIN_RB);
    }
    expect(await host.status()).toMatchObject({ state: "not_running", hint: expect.stringContaining("Open SketchUp") });
  });

  it("asks for setup again when the installed extension is outdated", async () => {
    const { base, host } = await settings();
    await host.setup();
    const main = join(plugins(base), "inertia_cad_bridge", "main.rb");
    await writeFile(main, SKETCHUP_MAIN_RB.replace(`BRIDGE_VERSION = '${BRIDGE_VERSION}'`, "BRIDGE_VERSION = '0.9.0'"));
    expect(await host.status()).toMatchObject({ state: "setup_required", hint: expect.stringContaining("outdated") });
    await host.setup();
    expect((await host.status()).state).toBe("not_running");
  });

  it("reads the bridge version from the embedded main.rb", () => {
    expect(BRIDGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(SKETCHUP_MAIN_RB).toContain(`BRIDGE_VERSION = '${BRIDGE_VERSION}'`);
  });

  it("reports not_installed when only SketchUp versions older than 2020 exist", async () => {
    const { base, host } = await settings(["SketchUp 2018", "SketchUp 2019"]);
    expect(await host.status()).toEqual({
      app: "sketchup",
      state: "not_installed",
      hint: expect.stringMatching(/SketchUp 2020 or newer.*SketchUp 2019/u),
      documents: [],
    });
    expect(await host.setupPlan()).toEqual([]);
    const error = await rejection(host.setup());
    expect(error.code).toBe("NOT_INSTALLED");
    expect(error.message).toMatch(/SketchUp 2020 or newer.*2018, 2019/u);
    await expect(stat(plugins(base, "SketchUp 2019"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("installs only into SketchUp 2020 and newer", async () => {
    const { base, host } = await settings(["SketchUp 2019", "SketchUp 2020"]);
    expect(await host.setupPlan()).toEqual([
      join(plugins(base, "SketchUp 2020"), "inertia_cad_bridge.rb"),
      join(plugins(base, "SketchUp 2020"), "inertia_cad_bridge", "main.rb"),
    ]);
    expect((await host.setup()).installedFor).toEqual(["SketchUp 2020"]);
    await expect(stat(plugins(base, "SketchUp 2019"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await host.status()).toMatchObject({ state: "not_running" });
  });

  it("judges the install by the newest SketchUp only", async () => {
    const { base, host } = await settings(["SketchUp 2024", "SketchUp 2025"]);
    await host.setup();
    await rm(join(plugins(base, "SketchUp 2025"), "inertia_cad_bridge"), { recursive: true });
    expect(await host.status()).toMatchObject({ state: "setup_required", hint: expect.stringContaining("SketchUp 2025") });
    await host.setup();
    await writeFile(
      join(plugins(base, "SketchUp 2024"), "inertia_cad_bridge", "main.rb"),
      "BRIDGE_VERSION = '0.1.0'",
    );
    expect(await host.status()).toMatchObject({ state: "not_running" });
  });

  it("asks for setup when the newest SketchUp has an outdated extension though an older one is current", async () => {
    const { base, host } = await settings(["SketchUp 2024", "SketchUp 2025"]);
    await host.setup();
    await writeFile(join(plugins(base, "SketchUp 2025"), "inertia_cad_bridge", "main.rb"), "BRIDGE_VERSION = '0.1.0'");
    expect(await host.status()).toMatchObject({ state: "setup_required", hint: expect.stringContaining("outdated") });
  });

  it("says a restart is needed when SketchUp is running during setup", async () => {
    const { home, host } = await settings();
    await writeDiscovery(home, await unusedPort());
    expect(await host.setup()).toMatchObject({ restartRequired: true, note: expect.stringContaining("Restart SketchUp") });
  });

  it("reports connected with the documents of each running SketchUp", async () => {
    const { home, host } = await settings();
    const bridge = await startBridge((request, socket) => answer(socket, request, { ok: true, result: { documents: [skpDocument] } }));
    await writeDiscovery(home, bridge.port);
    expect(await host.status()).toEqual({
      app: "sketchup",
      state: "connected",
      appVersion: "25.0.571",
      bridgeVersion: BRIDGE_VERSION,
      documents: [skpDocument],
    });
    expect(bridge.connections[0]!.lines[0]).toMatchObject({ method: "documents", token: TOKEN });
  });

  it("hints at an update when the running extension is outdated", async () => {
    const { home, host } = await settings();
    const bridge = await startBridge((request, socket) => answer(socket, request, { ok: true, result: { documents: [] } }));
    await writeDiscovery(home, bridge.port, { bridgeVersion: "0.9.0" });
    expect(await host.status()).toMatchObject({
      state: "connected",
      bridgeVersion: "0.9.0",
      hint: expect.stringContaining("outdated"),
    });
  });

  it("reports busy when no running SketchUp answers", async () => {
    const { home, host } = await settings();
    const bridge = await startBridge((_request, socket) => socket.destroy());
    await writeDiscovery(home, bridge.port);
    expect(await host.status()).toMatchObject({ state: "busy", documents: [], hint: expect.stringContaining("dialog") });
  });

  it("reports an unreadable documents answer as a broken bridge, not as busy", async () => {
    const { home, host } = await settings();
    const bridge = await startBridge((_request, socket) => {
      socket.write("<html>not the bridge</html>\n");
    });
    await writeDiscovery(home, bridge.port);
    expect(await host.status()).toMatchObject({ state: "error", documents: [], hint: expect.stringContaining("inertia_cad_setup") });
  });

  it("reports busy, not broken, when one SketchUp is unreadable and another does not answer", async () => {
    const { home, host } = await settings();
    const unreadable = await startBridge((_request, socket) => {
      socket.write("garbage\n");
    });
    const silent = await startBridge((_request, socket) => socket.destroy());
    await writeDiscovery(home, unreadable.port);
    await writeDiscovery(home, silent.port, { pid: process.ppid });
    expect(await host.status()).toMatchObject({ state: "busy", documents: [] });
  });

  it("reports a documents answer of the wrong shape as a broken bridge, not as busy", async () => {
    const { home, host } = await settings();
    const bridge = await startBridge((request, socket) => answer(socket, request, { ok: true, result: { documents: [{ name: 1 }] } }));
    await writeDiscovery(home, bridge.port);
    expect(await host.status()).toMatchObject({
      state: "error",
      documents: [],
      hint: expect.stringContaining("inertia_cad_setup"),
    });
  });

  it("keeps a running SketchUp's discovery file when a status call is cancelled before it is sent", async () => {
    const { home, host } = await settings();
    await host.setup();
    const bridge = await startBridge((request, socket) => answer(socket, request, { ok: true, result: { documents: [] } }));
    const file = await writeDiscovery(home, bridge.port);
    const controller = new AbortController();
    controller.abort();
    expect(await host.status(controller.signal)).toMatchObject({ state: "busy", documents: [] });
    expect((await stat(file)).isFile()).toBe(true);
    expect(await host.status()).toMatchObject({ state: "connected" });
  });

  it("drops a discovery file whose live pid has nothing listening on its port", async () => {
    const { home, host } = await settings();
    await host.setup();
    const file = await writeDiscovery(home, await unusedPort());
    expect(await host.status()).toMatchObject({ state: "not_running", documents: [] });
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("sketchUpSettingsBase", () => {
  it("uses APPDATA on Windows, Application Support on macOS, and nothing elsewhere", () => {
    expect(sketchUpSettingsBase("win32", join("home"), join("roaming"))).toBe(join("roaming", "SketchUp"));
    expect(sketchUpSettingsBase("win32", join("home"), undefined)).toBe(join("home", "AppData", "Roaming", "SketchUp"));
    expect(sketchUpSettingsBase("darwin", join("home"), undefined)).toBe(join("home", "Library", "Application Support"));
    expect(sketchUpSettingsBase("linux", join("home"), undefined)).toBeUndefined();
  });
});

const SCRIPT_NAME = `InertiaCadBridge-${createHash("sha256").update(AUTOCAD_BRIDGE_PS1).digest("hex").slice(0, 12)}.ps1`;
const POWERSHELL = join("C:", "Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

async function autoCad(run: AutoCadRunner, platform: NodeJS.Platform = "win32") {
  const state = join(await temporary("inertia-cad-state-"), "cad");
  const runner = vi.fn(run);
  return { state, runner, host: createAutoCadHost(platform, state, POWERSHELL, runner) };
}

const stdout = (body: unknown) => async () => ({ stdout: `\r\n${JSON.stringify(body)}\r\n` });

describe("AutoCAD host", () => {
  it("is unsupported off Windows and never starts PowerShell", async () => {
    const { host, runner } = await autoCad(stdout({ ok: true, result: {} }), "darwin");
    expect(await host.status()).toEqual({
      app: "autocad", state: "unsupported_platform", hint: expect.stringContaining("Windows"), documents: [],
    });
    expect((await rejection(host.call("query", {}, { documentId: "acad:x", timeoutMs: 1_000 }))).code).toBe("UNSUPPORTED_PLATFORM");
    expect(await host.setupPlan()).toBeUndefined();
    expect((await host.setup()).note).toContain("Windows");
    expect(runner).not.toHaveBeenCalled();
  });

  it("owns acad: document ids", async () => {
    const { host } = await autoCad(stdout({ ok: true, result: {} }));
    expect(host.owns("acad:C:/Drawings/Plan.dwg")).toBe(true);
    expect(host.owns(documentId)).toBe(false);
  });

  it("writes the bridge script with a byte-order mark under a content-hashed name", async () => {
    const { host, state } = await autoCad(stdout({ ok: true, result: {} }));
    await host.call("query", {}, { documentId: "acad:x", timeoutMs: 1_000 });
    expect(await readdir(state)).toEqual([SCRIPT_NAME]);
    const bytes = await readFile(join(state, SCRIPT_NAME));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.subarray(3).toString("utf8")).toBe(AUTOCAD_BRIDGE_PS1);
  });

  it("runs Windows PowerShell on the script with the request on stdin", async () => {
    const { host, state, runner } = await autoCad(stdout({ ok: true, result: { items: [] } }));
    const controller = new AbortController();
    const params = { documentId: "acad:x", layer: "A-*" };
    expect(await host.call("query", params, { documentId: "acad:x", timeoutMs: 4_321, signal: controller.signal }))
      .toEqual({ items: [] });
    expect(runner).toHaveBeenCalledTimes(1);
    const [executable, args, options] = runner.mock.calls[0]!;
    expect(executable).toBe(POWERSHELL);
    expect(args).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-File", join(state, SCRIPT_NAME)]);
    expect(options).toMatchObject({ cwd: state, timeoutMs: 4_321, signal: controller.signal });
    expect(JSON.parse(options.input)).toEqual({
      v: 1,
      id: expect.any(String),
      method: "query",
      params: { ...params, deadlineAt: expect.any(Number) },
    });
  });

  it("tells the bridge when Inertia stops waiting, and nothing about a dialog", async () => {
    const { host, runner } = await autoCad(stdout({ ok: true, result: { status: "applied" } }));
    const before = Date.now();
    await host.call("apply", { documentId: "acad:x" }, { documentId: "acad:x", timeoutMs: 600_000 });
    const after = Date.now();
    const { params } = JSON.parse(runner.mock.calls[0]![2].input) as { params: Record<string, unknown> };
    // With no approval dialog there is no waiting process to watch.
    expect(params).not.toHaveProperty("parentPid");
    expect(params.deadlineAt).toBeGreaterThanOrEqual(before + 600_000);
    expect(params.deadlineAt).toBeLessThanOrEqual(after + 600_000);
    expect(params.documentId).toBe("acad:x");
  });

  it("keeps an existing script whose content is current", async () => {
    const { host, state } = await autoCad(stdout({ ok: true, result: {} }));
    await mkdir(state, { recursive: true });
    const script = join(state, SCRIPT_NAME);
    await writeFile(script, `\uFEFF${AUTOCAD_BRIDGE_PS1}`);
    const written = (await stat(script)).mtimeMs;
    await host.call("query", {}, { documentId: "acad:x", timeoutMs: 1_000 });
    expect(await readdir(state)).toEqual([SCRIPT_NAME]);
    expect((await stat(script)).mtimeMs).toBe(written);
  });

  it.each([
    { label: "edited", content: `\uFEFF${AUTOCAD_BRIDGE_PS1}\nInvoke-Something-Else` },
    { label: "truncated", content: `\uFEFF${AUTOCAD_BRIDGE_PS1.slice(0, 100)}` },
    { label: "missing its byte-order mark", content: AUTOCAD_BRIDGE_PS1 },
  ])("replaces an existing script that was $label before PowerShell runs it", async ({ content }) => {
    let seen = "";
    const { host, state } = await autoCad(async (_executable, args) => {
      seen = await readFile(args.at(-1)!, "utf8");
      return { stdout: JSON.stringify({ ok: true, result: {} }) };
    });
    await mkdir(state, { recursive: true });
    await writeFile(join(state, SCRIPT_NAME), content);
    await host.call("query", {}, { documentId: "acad:x", timeoutMs: 1_000 });
    expect(seen).toBe(`\uFEFF${AUTOCAD_BRIDGE_PS1}`);
    expect(await readdir(state)).toEqual([SCRIPT_NAME]);
  });

  it("checks the script once per host and again for a new host", async () => {
    const { host, state, runner } = await autoCad(stdout({ ok: true, result: {} }));
    await host.call("query", {}, { documentId: "acad:x", timeoutMs: 1_000 });
    const script = join(state, SCRIPT_NAME);
    await writeFile(script, "edited while Inertia runs");
    await host.call("query", {}, { documentId: "acad:x", timeoutMs: 1_000 });
    expect(await readFile(script, "utf8")).toBe("edited while Inertia runs");
    await createAutoCadHost("win32", state, POWERSHELL, runner).call("query", {}, { documentId: "acad:x", timeoutMs: 1_000 });
    expect(await readFile(script, "utf8")).toBe(`\uFEFF${AUTOCAD_BRIDGE_PS1}`);
  });

  it("refuses to run when the script cannot be written", async () => {
    const runner = vi.fn<AutoCadRunner>();
    const { host, state } = await autoCad(runner);
    // A folder where the script belongs: the rename fails and the content is not the script.
    await mkdir(join(state, SCRIPT_NAME, "occupied"), { recursive: true });
    const error = await rejection(host.call("apply", {}, { documentId: "acad:x", timeoutMs: 1_000 }));
    expect(error).toMatchObject({ code: "SETUP_FAILED", message: expect.stringContaining("bridge script") });
    expect(runner).not.toHaveBeenCalled();
    expect((await readdir(state)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("never starts PowerShell for a request cancelled before it starts", async () => {
    const runner = vi.fn<AutoCadRunner>();
    const { host } = await autoCad(runner);
    const controller = new AbortController();
    controller.abort();
    const error = await rejection(host.call("apply", {}, { documentId: "acad:x", timeoutMs: 1_000, signal: controller.signal }));
    expect(error.code).toBe("CANCELLED");
    expect(runner).not.toHaveBeenCalled();
  });

  it("raises the bridge's own error code from stdout", async () => {
    const { host } = await autoCad(stdout({ ok: false, error: { code: "STALE_TARGET", message: "Entity 2A changed." } }));
    const error = await rejection(host.call("apply", {}, { documentId: "acad:x", timeoutMs: 1_000 }));
    expect(error).toMatchObject({ code: "STALE_TARGET", message: "Entity 2A changed." });
  });

  it.each([
    { label: "not JSON", output: "WARNING: profile\n{}" },
    { label: "the wrong shape", output: JSON.stringify({ result: 1 }) },
    { label: "empty", output: "" },
  ])("calls stdout that is $label HOST_UNREADABLE", async ({ output }) => {
    const { host } = await autoCad(async () => ({ stdout: output }));
    const error = await rejection(host.call("query", {}, { documentId: "acad:x", timeoutMs: 1_000 }));
    expect(error).toMatchObject({ code: HOST_UNREADABLE, message: "The AutoCAD bridge sent an unreadable answer." });
  });

  it("adds the end of PowerShell's stderr to an unreadable answer", async () => {
    const stderr = `\r\n${"x".repeat(600)}File C:\\Inertia\\bridge.ps1 cannot be loaded because running scripts is disabled.\r\n`;
    const { host } = await autoCad(async () => ({ stdout: "", stderr }));
    const error = await rejection(host.call("apply", {}, { documentId: "acad:x", timeoutMs: 1_000 }));
    expect(error.code).toBe(HOST_UNREADABLE);
    expect(error.message).toBe(`The AutoCAD bridge sent an unreadable answer. PowerShell said: ${stderr.trim().slice(-500)}`);
    expect(error.message).toContain("running scripts is disabled.");
    expect(error.message).not.toContain("x".repeat(600));
  });

  it("adds nothing for blank stderr, and ignores stderr on a readable answer", async () => {
    const blank = await autoCad(async () => ({ stdout: "nope", stderr: " \r\n " }));
    expect((await rejection(blank.host.call("query", {}, { documentId: "acad:x", timeoutMs: 1_000 }))).message)
      .toBe("The AutoCAD bridge sent an unreadable answer.");
    const readable = await autoCad(async () => ({
      stdout: JSON.stringify({ ok: false, error: { code: "STALE_TARGET", message: "Entity 2A changed." } }),
      stderr: "WARNING: something",
    }));
    expect(await rejection(readable.host.call("apply", {}, { documentId: "acad:x", timeoutMs: 1_000 })))
      .toMatchObject({ code: "STALE_TARGET", message: "Entity 2A changed." });
  });

  it.each([
    { code: "unavailable" as const, expected: "HOST_ERROR", message: "PowerShell could not start" },
    { code: "output-limit" as const, expected: HOST_UNREADABLE, message: "fewer objects" },
    { code: "timeout" as const, expected: "HOST_TIMEOUT", message: "did not answer in time" },
    { code: "cleanup" as const, expected: "HOST_TIMEOUT", message: "did not answer in time" },
    { code: "failed" as const, expected: "HOST_DISCONNECTED", message: "stopped before it answered" },
  ])("maps a runner $code failure to $expected", async ({ code, expected, message }) => {
    const { host } = await autoCad(async () => {
      throw new RestrictedCliError(code, "runner detail");
    });
    const error = await rejection(host.call("query", {}, { documentId: "acad:x", timeoutMs: 1_000 }));
    expect(error.code).toBe(expected);
    expect(error.message).toContain(message);
  });

  it("keeps what PowerShell printed when it exits with an error", async () => {
    const { host } = await autoCad(async () => {
      throw new RestrictedCliError("failed", "stopped", undefined, "File cannot be loaded because running scripts is disabled.");
    });
    const error = await rejection(host.call("apply", {}, { documentId: "acad:x", timeoutMs: 1_000 }));
    expect(error).toMatchObject({
      code: "HOST_DISCONNECTED",
      message: expect.stringContaining("PowerShell said: File cannot be loaded because running scripts is disabled."),
    });
  });

  it("explains an oversized capture in terms of its size", async () => {
    const { host } = await autoCad(async () => {
      throw new RestrictedCliError("output-limit", "too much");
    });
    const error = await rejection(host.call("capture", {}, { documentId: "acad:x", timeoutMs: 1_000 }));
    expect(error).toMatchObject({ code: HOST_UNREADABLE, message: expect.stringContaining("smaller maxWidth and maxHeight") });
  });

  it("passes other runner failures through unchanged", async () => {
    const failure = new TypeError("runner bug");
    const { host } = await autoCad(async () => {
      throw failure;
    });
    await expect(host.call("query", {}, { documentId: "acad:x", timeoutMs: 1_000 })).rejects.toBe(failure);
  });

  it("reports connected with the open drawings", async () => {
    const drawing = { documentId: "acad:C:/Plan.dwg", app: "autocad", name: "Plan.dwg", path: "C:/Plan.dwg", modified: false, active: true };
    const { host, runner } = await autoCad(stdout({ ok: true, result: { documents: [drawing] } }));
    expect(await host.status()).toEqual({ app: "autocad", state: "connected", bridgeVersion: BRIDGE_VERSION, documents: [drawing] });
    expect(JSON.parse(runner.mock.calls[0]![2].input)).toMatchObject({ method: "documents", params: {} });
    // Under OpenCode's 30-second host-tool timeout.
    expect(runner.mock.calls[0]![2].timeoutMs).toBe(25_000);
  });

  it.each([
    { code: "HOST_OFFLINE", state: "not_running" },
    { code: "HOST_UNAVAILABLE", state: "not_running" },
    { code: "NOT_INSTALLED", state: "not_installed" },
    { code: "HOST_BUSY", state: "busy" },
    { code: "COM_FAILURE", state: "error" },
  ])("reports a $code answer as $state", async ({ code, state }) => {
    const { host } = await autoCad(stdout({ ok: false, error: { code, message: `${code} hint` } }));
    expect(await host.status()).toEqual({ app: "autocad", state, hint: `${code} hint`, documents: [] });
  });

  it("reports a timed-out or malformed status as error", async () => {
    const timedOut = await autoCad(async () => {
      throw new RestrictedCliError("timeout", "slow");
    });
    expect((await timedOut.host.status()).state).toBe("error");
    const malformed = await autoCad(stdout({ ok: true, result: { documents: "none" } }));
    expect(await malformed.host.status()).toMatchObject({ state: "error", hint: expect.stringContaining("inertia_cad_setup") });
    const unreadable = await autoCad(async () => ({ stdout: "", stderr: "Execution policy refused the script." }));
    expect(await unreadable.host.status()).toMatchObject({
      state: "error",
      hint: expect.stringContaining("PowerShell said: Execution policy refused the script."),
    });
  });

  it("has nothing to install on Windows", async () => {
    const { host } = await autoCad(stdout({ ok: true, result: {} }));
    expect(await host.setup()).toEqual({
      app: "autocad", installedFor: [], restartRequired: false, note: expect.stringContaining("Nothing to install"),
    });
  });
});

describe("embedded bridge sources", () => {
  it("match the bridge files under src/server/cad/hosts", () => {
    const result = spawnSync(process.execPath, ["scripts/sync-cad-host-sources.mjs", "--check"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("CAD host sources are current.");
  });
});
