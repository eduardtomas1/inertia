// @inertia-test-suite portable
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as ownedProcesses from "../../src/node/runtime-owned-processes";
import { RuntimeOwnedProcessJournal } from "../../src/node/runtime-owned-processes";
import { parseAntigravityModels, readAntigravityModels } from "../../src/server/provider/antigravity-models";
import { antigravityArguments } from "../../src/server/provider/antigravity-stream";
import { ProviderMetadataCache, readProviderMetadata } from "../../src/server/provider/metadata";
import { providerSnapshot } from "../../src/server/runtime-snapshots";
import { detectProvider } from "../../src/server/providers";
import { buildComposerModelRoutes, readyModelChooserRoutes } from "../../src/renderer/src/utils/modelChooserRoutes";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { activatePreparedRuntimeOwnedProcessRegistry } from "../helpers/prepared-runtime-owned-process-registry";
import { executableProcessExists } from "../helpers/executable-process";
import { portableFixtureRoot, portableNodeExecutable, removePortableFixture, waitFor, writeNodeFlagExecutable, writeNodeSubcommand } from "../helpers/portable-provider-fixture";

const CATALOG = "gemini-test-high       Gemini Test (High)\nclaude-test-thinking   Claude Test (Thinking)\n";
const roots: string[] = [];
const deactivators: Array<() => void> = [];
const environment = { ...process.env, NO_COLOR: "1" };

function fixture(source: string): { root: string; executable: string } {
  const root = portableFixtureRoot("Antigravity models");
  roots.push(root);
  const executable = portableNodeExecutable(root, "agy");
  writeNodeSubcommand(root, "models", source);
  return { root, executable };
}

function ownProcesses(root: string): { journal: RuntimeOwnedProcessJournal; generation: string } {
  const registryRoot = join(root, "owned");
  mkdirSync(registryRoot);
  chmodSync(registryRoot, 0o700);
  const generation = "65000000-0000-4000-8000-000000000001:1";
  const deactivate = activatePreparedRuntimeOwnedProcessRegistry(
    registryRoot, generation, "test:65000000-0000-4000-8000-000000000001",
    (process.platform === "darwin" || process.platform === "linux")
      ? { darwinGuardianPath: join(process.cwd(), "resources/generated/runtime-process-guardian/runtime-process-guardian") }
      : {},
  );
  if (deactivate) deactivators.push(deactivate);
  return { journal: new RuntimeOwnedProcessJournal(registryRoot), generation };
}

afterEach(async () => {
  while (deactivators.length) deactivators.pop()?.();
  await Promise.all(roots.splice(0).map(removePortableFixture));
});

describe("Antigravity catalog", () => {
  it("parses documented slug/name columns without guessing defaults or capabilities", () => {
    expect(parseAntigravityModels(CATALOG)).toEqual([
      expect.objectContaining({ id: "gemini-test-high", label: "Gemini Test (High)" }),
      expect.objectContaining({ id: "claude-test-thinking", label: "Claude Test (Thinking)" }),
    ]);
    for (const model of parseAntigravityModels(CATALOG)) {
      expect(model).toMatchObject({ isDefault: false, inputModalities: ["text"], reasoningOptions: [], defaultReasoningEffort: "", fastMode: null });
    }
    expect(parseAntigravityModels("\u001b[32mgemini-test-high\u001b[0m\tGemini Test (High)\r\n"))
      .toEqual([parseAntigravityModels(CATALOG)[0]]);
    expect(parseAntigravityModels("gemini-test-high\t\u001b]8;;https://example.test/private\u0007Gemini Test (High)\u001b]8;;\u0007\n"))
      .toEqual([parseAntigravityModels(CATALOG)[0]]);
  });

  it.each([
    "", "Please sign in to view available models.", "Fetching available models...", "{\"models\":[]}",
    "--model  Bad flag", "provider-default  False default", "bad;command  Bad identifier", "model\tBad\0label",
    "model\t\0Bad label", "model\tBad\u0085label", "model\tBad\u202elabel",
    `${CATALOG}gemini-test-high  Duplicate`, `${CATALOG}malformed`,
    `model  ${"x".repeat(121)}`, `${"x".repeat(161)}  Too long`,
    Array.from({ length: 129 }, (_, index) => `model-${index}  Model ${index}`).join("\n"),
    " ".repeat(65_537),
  ])("rejects malformed, empty, ambiguous or oversized catalogs %#", (output) => {
    expect(() => parseAntigravityModels(output)).toThrow("did not return a valid catalog");
  });

  it("makes discovered models selectable and sends their exact slug to the same CLI", async () => {
    const root = portableFixtureRoot("Antigravity catalog route");
    roots.push(root);
    const capture = join(root, "capture.json");
    const executable = writeNodeFlagExecutable(root, "agy", `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.2.7"); process.exit(0); }
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, home: process.env.HOME, injected: process.env.NODE_OPTIONS, unrelatedSecret: process.env.OPENAI_API_KEY, noColor: process.env.NO_COLOR }));
process.stdin.resume();
process.stdin.once("end", () => { process.stderr.write("Fetching available models...\\n"); process.stdout.write(${JSON.stringify(CATALOG)}); });
`);
    const detection = await detectProvider("antigravity", { command: executable, cwd: root }, {
      executableCandidates: async () => [executable],
    });
    expect(detection).toMatchObject({ executable, canRun: true, authState: "unknown" });
    const cache = new ProviderMetadataCache();
    const metadata = await cache.metadata("antigravity", executable, {
      ...environment, HOME: root, NODE_OPTIONS: "--invalid-fixture-option", OPENAI_API_KEY: "fixture-secret",
    }, root);
    expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual({ args: ["models"], home: root, noColor: "1" });
    expect(metadata.metadataState.models.freshness).toBe("fresh");
    const provider = providerSnapshot(detection, metadata);
    const routes = readyModelChooserRoutes(buildComposerModelRoutes(
      [provider], [], providerNativeModelSelection({ providerId: "antigravity" }),
    ));
    expect(routes.map(({ modelId }) => modelId)).toEqual(["provider-default", "gemini-test-high", "claude-test-thinking"]);
    const selected = routes[1]!;
    expect(selected).toMatchObject({ selectable: true, providerReady: true, reasoningOptions: [] });
    expect(selected.selection).toMatchObject({ harnessId: "antigravity-cli", backendProfileId: "builtin:antigravity", contextWindowOverride: null, capabilities: [], reasoningEffort: null });
    expect(antigravityArguments({ modelSelection: selected.selection, interactionMode: "build", access: "supervised" }))
      .toEqual(["--input-format", "stream-json", "--output-format", "stream-json", "--model", "gemini-test-high"]);
  });

  it.each([
    `process.stderr.write(${JSON.stringify(CATALOG)});`,
    `process.stdout.write(${JSON.stringify(CATALOG)}); process.stderr.write("private-account-data"); process.exitCode = 1;`,
    `process.stdout.write("private-account-data");`,
    `process.stdout.write("x".repeat(70_000)); setInterval(() => {}, 1000);`,
    `process.stdout.write(${JSON.stringify(CATALOG)}); process.stderr.write("x".repeat(70_000)); setInterval(() => {}, 1000);`,
  ])("never accepts failure, stderr or excessive output as catalog data %#", async (source) => {
    const { root, executable } = fixture(source);
    await expect(readAntigravityModels(executable, environment, root)).rejects.toThrow("did not return a valid catalog");
  });

  it("retries an initially empty catalog through the production metadata reader", async () => {
    const { root, executable } = fixture("process.stdout.write('');");
    const cache = new ProviderMetadataCache();
    expect((await cache.metadata("antigravity", executable, environment, root)).metadataState.models)
      .toMatchObject({ freshness: "unavailable", lastAttemptedAt: expect.any(String) });
    writeNodeSubcommand(root, "models", `process.stdout.write(${JSON.stringify(CATALOG)});`);
    expect((await cache.metadata("antigravity", executable, environment, root)).models).toHaveLength(2);
    await expect(readProviderMetadata("antigravity", "must-not-spawn", {}, root, ["rateLimits"]))
      .resolves.toEqual({});
  });

  it.each([
    { mode: "timeout", descendants: false },
    { mode: "cancel", descendants: false },
    { mode: "cancel", descendants: true },
  ])("bounds $mode with descendants=$descendants and preserves cleanup authority", async ({ mode, descendants }) => {
    const { root, executable } = fixture(`
const fs = require("node:fs");
const pids = [process.pid];
if (${descendants}) {
  const child = require("node:child_process").spawn(process.execPath, ["-e", "require('node:fs').writeFileSync('child-ready', 'ready'); setInterval(() => {}, 1000)"], { stdio: "ignore" });
  pids.push(child.pid);
}
fs.writeFileSync("pids.json", JSON.stringify(pids));
process.stdout.write(${JSON.stringify(CATALOG)});
setInterval(() => {}, 1000);
`);
    const { journal, generation } = ownProcesses(root);
    const controller = new AbortController();
    let expire!: () => void;
    const read = readAntigravityModels(executable, environment, root, {
      signal: controller.signal,
      scheduleDeadline: (onDeadline, timeoutMs) => {
        expect(timeoutMs).toBe(6_000);
        expire = onDeadline;
        return { cancel: () => undefined };
      },
    });
    // Darwin cannot prove containment after NOTE_FORK on forced cancellation.
    // Retain its fail-closed claim even after all known processes stop.
    const cleanupUnconfirmed = process.platform === "darwin" && descendants;
    const outcome = read.then(() => null, (error: unknown) => error);
    try {
      await waitFor("catalog subprocess", () => existsSync(join(root, "pids.json")), 15_000);
      if (descendants) await waitFor("catalog descendant readiness", () => existsSync(join(root, "child-ready")), 15_000);
      if (mode === "cancel") controller.abort();
      else expire();
      expect(await outcome).toMatchObject(cleanupUnconfirmed
        ? { code: "process-tree-termination-unconfirmed" }
        : { message: "Antigravity model discovery did not return a valid catalog." });
      const pids: number[] = JSON.parse(readFileSync(join(root, "pids.json"), "utf8"));
      for (const pid of pids) expect(executableProcessExists(pid)).toBe(false);
      expect(journal.records(generation)).toHaveLength(cleanupUnconfirmed ? 1 : 0);
    } finally {
      controller.abort();
      await outcome;
    }
  }, 30_000);

  it("joins natural completion and retires lingering descendants before accepting a catalog", async () => {
    const { root, executable } = fixture(`
const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
require("node:fs").writeFileSync("pids.json", JSON.stringify([process.pid, child.pid]));
process.stdout.write(${JSON.stringify(CATALOG)}, () => process.exit(0));
`);
    const { journal, generation } = ownProcesses(root);
    await expect(readAntigravityModels(executable, environment, root)).resolves.toHaveLength(2);
    const pids: number[] = JSON.parse(readFileSync(join(root, "pids.json"), "utf8"));
    for (const pid of pids) expect(executableProcessExists(pid)).toBe(false);
    expect(journal.records(generation)).toEqual([]);
  });

  it("rejects cancellation during the natural-close retirement barrier", async () => {
    const { root, executable } = fixture(`process.stdout.write(${JSON.stringify(CATALOG)});`);
    const original = ownedProcesses.awaitRuntimeOwnedProcessStopped;
    let retiring = false;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const retirement = vi.spyOn(ownedProcesses, "awaitRuntimeOwnedProcessStopped").mockImplementation(async (child) => {
      const confirmed = await original(child);
      retiring = true;
      await barrier;
      return confirmed;
    });
    const controller = new AbortController();
    const read = readAntigravityModels(executable, environment, root, { signal: controller.signal });
    const outcome = read.then(() => null, (error: unknown) => error);
    try {
      await waitFor("catalog retirement barrier", () => retiring);
      controller.abort();
      release();
      expect(await outcome).toMatchObject({ message: "Antigravity model discovery did not return a valid catalog." });
    } finally {
      controller.abort();
      release();
      await outcome;
      retirement.mockRestore();
    }
  });

  it("does not spawn when already cancelled or return a catalog when cleanup is unconfirmed", async () => {
    await expect(readAntigravityModels("must-not-spawn", {}, "/", { signal: AbortSignal.abort() })).rejects.toThrow("did not return a valid catalog");
    const { root, executable } = fixture("require('node:fs').writeFileSync('pid', String(process.pid)); setInterval(() => {}, 1000);");
    let expire!: () => void;
    const read = readAntigravityModels(executable, environment, root, {
      terminateProcessTree: async () => false,
      scheduleDeadline: (onDeadline) => {
        expire = onDeadline;
        return { cancel: () => undefined };
      },
    });
    const outcome = read.then(() => null, (error: unknown) => error);
    try {
      await waitFor("catalog subprocess", () => existsSync(join(root, "pid")), 15_000);
      expire();
      expect(await outcome).toMatchObject({ code: "process-tree-termination-unconfirmed" });
    } finally {
      expire();
      await outcome;
      if (existsSync(join(root, "pid"))) process.kill(Number(readFileSync(join(root, "pid"), "utf8")), "SIGKILL");
    }
  }, 30_000);
});
