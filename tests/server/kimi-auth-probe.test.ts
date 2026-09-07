// @inertia-test-suite portable
import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { RuntimeOwnedProcessJournal, runtimeOwnedProcessOwnershipIsTainted } from "../../src/node/runtime-owned-processes";
import { probeKimiAuthentication } from "../../src/server/provider/kimi-auth-probe";
import { ProcessTreeTerminationError, terminateProcessTreeAndWait } from "../../src/server/process-lifecycle";
import { activatePreparedRuntimeOwnedProcessRegistry } from "../helpers/prepared-runtime-owned-process-registry";
import { executableProcessExists } from "../helpers/executable-process";
import { portableFixtureRoot, portableNodeExecutable, readStableFixtureCapture, removePortableFixture,
  waitFor, writeNodeSubcommand } from "../helpers/portable-provider-fixture";

interface Capture {
  pid: number;
  cwd: string;
  args: string[];
  marker: string;
  descendantPid?: number;
  messages: Array<{ method?: string; params?: unknown }>;
}

const terminal = { id: "login", name: "Kimi login", type: "terminal", args: ["--login"], env: {} };

function fixture(mode = "terminal", withDescendant = false, initializationDelayMs = 0) {
  const root = realpathSync(portableFixtureRoot("Kimi initialize-only auth probe"));
  const command = portableNodeExecutable(root, "kimi");
  const capturePath = join(root, "capture.json");
  const environment = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    HOME: root, USERPROFILE: root, KIMI_CODE_HOME: root, PROBE_MARKER: "isolated-test",
  };
  writeNodeSubcommand(root, "acp", `
const fs = require("node:fs");
const state = { pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2), marker: process.env.PROBE_MARKER, messages: [] };
const capturePath = ${JSON.stringify(capturePath)};
const save = () => { fs.writeFileSync(capturePath + ".next", JSON.stringify(state)); fs.renameSync(capturePath + ".next", capturePath); };
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const mode = ${JSON.stringify(mode)};
if (${withDescendant}) state.descendantPid = require("node:child_process").spawn(process.execPath,
  ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: false }).pid;
save();
const readRequests = () => require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line); state.messages.push(message); save();
  if (message.method !== "initialize") throw new Error("Authentication discovery sent a forbidden operation.");
  if (mode === "timeout") return;
  if (mode === "early-exit") return process.exit(0);
  if (mode === "failed-exit") return process.exit(3);
  if (mode === "malformed-json") return process.stdout.write("{synthetic-private-value\\n");
  if (mode === "malformed-utf8") return process.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]));
  if (mode === "oversized") return process.stdout.write("x".repeat(65 * 1024));
  if (mode === "flood") return process.stdout.write(Array(128).fill(JSON.stringify({ jsonrpc: "2.0", method: "fixture/noop" })).join("\\n") + "\\n");
  if (mode === "stderr-flood") return process.stderr.write("x".repeat(513 * 1024));
  if (mode === "rpc-error") return send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "synthetic-private-value" } });
  let authMethods = mode === "none" ? [] : mode === "agent" ? [{ id: "login", name: "Kimi login" }] : [${JSON.stringify(terminal)}];
  if (mode === "invalid-descriptor") authMethods[0].args = ["--synthetic-private-value"];
  if (mode === "invalid-descriptor-env") authMethods[0].env = { NODE_OPTIONS: 123 };
  if (mode === "unknown-descriptor-type") authMethods[0].type = "other";
  send({ jsonrpc: "2.0", id: mode === "invalid-id" ? {} : mode === "unmatched-id" ? "wrong-response-id" : message.id,
    result: { protocolVersion: mode === "wrong-protocol" ? 2 : 1, agentCapabilities: {}, authMethods,
      agentInfo: { name: mode === "wrong-agent" ? "Other fixture" : "Kimi Code CLI", version: "fixture" } } });
});
if (${initializationDelayMs} > 0) setTimeout(readRequests, ${initializationDelayMs});
else readRequests();
setInterval(() => {}, 1000);
`);
  return {
    root, command, capturePath, environment,
    capture: () => readStableFixtureCapture<Capture>(capturePath),
  };
}

function assertStopped(capture: Capture): void {
  expect(executableProcessExists(capture.pid)).toBe(false);
  if (capture.descendantPid) expect(executableProcessExists(capture.descendantPid)).toBe(false);
  expect(capture.messages.map(({ method }) => method)).toEqual(["initialize"]);
}

describe("Kimi initialize-only authentication discovery", () => {
  it.each(["terminal", "agent", "none"])("returns the validated %s descriptor only after process cleanup", async (mode) => {
    const app = fixture(mode);
    try {
      const result = await probeKimiAuthentication(app.command, app.root, app.environment);
      expect(result).toEqual(mode === "terminal" ? terminal
        : mode === "agent" ? { id: "login", name: "Kimi login" } : undefined);
      const capture = app.capture();
      expect(capture).toMatchObject({ cwd: app.root, args: [], marker: "isolated-test" });
      expect(capture.messages).toEqual([expect.objectContaining({
        method: "initialize", params: expect.objectContaining({
          protocolVersion: 1, clientCapabilities: { auth: { terminal: true } },
        }),
      })]);
      assertStopped(capture);
    } finally { await removePortableFixture(app.root); }
  });

  it.each([
    "malformed-json", "malformed-utf8", "oversized",
    "flood", "stderr-flood", "rpc-error", "invalid-id", "unmatched-id",
    "wrong-protocol", "wrong-agent", "invalid-descriptor", "invalid-descriptor-env",
    "unknown-descriptor-type", "timeout",
  ])("rejects %s without any login or session request and cleans up", async (mode) => {
    const waitsForTimeout = mode === "timeout" || mode === "unmatched-id";
    // Exercise a cold fixture that cannot consume initialize inside 300 ms.
    const app = fixture(mode, false, waitsForTimeout ? 450 : 0);
    try {
      const failure = await probeKimiAuthentication(app.command, app.root, app.environment, undefined,
        { timeoutMs: 2_000 })
        .then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/Kimi authentication discovery/u);
      if (waitsForTimeout) expect((failure as Error).message).toContain("timed out");
      expect((failure as Error).message).not.toContain("synthetic-private-value");
      expect(failure).not.toBeInstanceOf(ProcessTreeTerminationError);
      assertStopped(app.capture());
    } finally { await removePortableFixture(app.root); }
  });

  it.each(["early-exit", "failed-exit"])("rejects %s without accepting authentication or concealing cleanup uncertainty", async (mode) => {
    const app = fixture(mode);
    try {
      const failure = await probeKimiAuthentication(app.command, app.root, app.environment)
        .then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      // Windows can observe ACP EOF before ChildProcess.close. If taskkill then
      // finds the root already gone, strict cleanup must report uncertainty;
      // the known fixture PID being dead is not proof about an untracked tree.
      if (failure instanceof ProcessTreeTerminationError) {
        expect(process.platform).toBe("win32");
        expect(failure.code).toBe("process-tree-termination-unconfirmed");
        expect(failure.message).toBe("Kimi authentication discovery process tree could not be confirmed stopped.");
      } else {
        expect([
          "Kimi authentication discovery exited before initialization completed.",
          "Kimi authentication discovery returned invalid initialization data.",
        ]).toContain((failure as Error).message);
      }
      assertStopped(app.capture());
    } finally { await removePortableFixture(app.root); }
  });

  it("rejects cancellation before spawning", async () => {
    const app = fixture();
    const abort = new AbortController();
    abort.abort(new Error("synthetic-private-value"));
    try {
      await expect(probeKimiAuthentication(app.command, app.root, app.environment, abort.signal))
        .rejects.toThrow("Kimi authentication discovery was cancelled.");
      expect(existsSync(app.capturePath)).toBe(false);
    } finally { await removePortableFixture(app.root); }
  });

  it("cancels an outstanding initialize and waits for its process to stop", async () => {
    const app = fixture("timeout");
    const abort = new AbortController();
    const pending = probeKimiAuthentication(app.command, app.root, app.environment, abort.signal);
    const rejected = expect(pending).rejects.toThrow("Kimi authentication discovery was cancelled.");
    try {
      await waitFor("the initialize request", () => app.capture().messages.length === 1);
      abort.abort();
      await rejected;
      assertStopped(app.capture());
    } finally { abort.abort(); await pending.catch(() => undefined); await removePortableFixture(app.root); }
  });

  it("does not release a valid descriptor while cleanup is pending or after cancellation during cleanup", async () => {
    const app = fixture();
    const abort = new AbortController();
    let beginCleanup!: () => void;
    let finishCleanup!: () => void;
    const started = new Promise<void>((resolve) => { beginCleanup = resolve; });
    const finish = new Promise<void>((resolve) => { finishCleanup = resolve; });
    let returned = false;
    const pending = probeKimiAuthentication(app.command, app.root, app.environment, abort.signal, {
      terminateProcessTree: async (child, force) => {
        beginCleanup(); await finish;
        return await terminateProcessTreeAndWait(child, force);
      },
    }).finally(() => { returned = true; });
    const rejected = expect(pending).rejects.toThrow("Kimi authentication discovery was cancelled.");
    try {
      await started;
      expect(returned).toBe(false);
      abort.abort();
      finishCleanup();
      await rejected;
      assertStopped(app.capture());
    } finally { finishCleanup(); await pending.catch(() => undefined); await removePortableFixture(app.root); }
  });

  it("reports unconfirmed cleanup instead of returning a valid descriptor", async () => {
    const app = fixture();
    try {
      await expect(probeKimiAuthentication(app.command, app.root, app.environment, undefined, {
        terminateProcessTree: async (child, force) => {
          await terminateProcessTreeAndWait(child, force);
          return false;
        },
      })).rejects.toBeInstanceOf(ProcessTreeTerminationError);
      assertStopped(app.capture());
    } finally { await removePortableFixture(app.root); }
  });

  it("rejects an executable spawn failure without accepting a descriptor", async () => {
    const root = portableFixtureRoot("Kimi missing auth executable");
    try {
      await expect(probeKimiAuthentication(join(root, "missing-kimi"), root, {}))
        .rejects.toThrow(/Kimi authentication discovery/u);
    } finally { await removePortableFixture(root); }
  });

  it.each([
    { withDescendant: false, name: "retires the real owned guardian before returning" },
    { withDescendant: true, name: process.platform === "darwin"
      ? "rejects fork-tainted macOS cleanup and retains its durable ownership claim"
      : "retires the real owned guardian and its descendant before returning" },
  ])("$name", async ({ withDescendant }) => {
    const app = fixture("terminal", withDescendant);
    const registryRoot = join(app.root, "runtime-owned");
    mkdirSync(registryRoot); chmodSync(registryRoot, 0o700);
    const generation = "79000000-0000-4000-8000-000000000079:1";
    const deactivate = activatePreparedRuntimeOwnedProcessRegistry(registryRoot, generation,
      "test:79000000-0000-4000-8000-000000000079",
      process.platform === "linux" || process.platform === "darwin" ? {
        darwinGuardianPath: join(process.cwd(), "resources/generated/runtime-process-guardian/runtime-process-guardian"),
      } : {});
    const journal = new RuntimeOwnedProcessJournal(registryRoot);
    try {
      expect(deactivate).toBeTypeOf("function");
      const forkUncertainty = process.platform === "darwin" && withDescendant;
      const pending = probeKimiAuthentication(app.command, app.root, app.environment);
      if (forkUncertainty) {
        // macOS NOTE_FORK cannot certify every descendant's identity. Strict
        // cancellation must retain that claim even after known children stop.
        await expect(pending).rejects.toBeInstanceOf(ProcessTreeTerminationError);
      } else {
        await expect(pending).resolves.toEqual(terminal);
      }
      const capture = app.capture();
      if (withDescendant) expect(capture.descendantPid).toBeGreaterThan(0);
      else expect(capture.descendantPid).toBeUndefined();
      assertStopped(capture);
      expect(journal.records(generation)).toHaveLength(forkUncertainty ? 1 : 0);
      expect(runtimeOwnedProcessOwnershipIsTainted()).toBe(forkUncertainty);
    } finally { deactivate?.(); await removePortableFixture(app.root); }
  });
});
