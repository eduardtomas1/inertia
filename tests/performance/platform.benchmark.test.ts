import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  arch,
  cpus,
  freemem,
  homedir,
  platform,
  release,
  tmpdir,
  totalmem,
  type,
  version,
} from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import type { IDisposable, IPty } from "node-pty";
import type WebSocket from "ws";
import { describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { terminateProcessTreeAndWait } from "../../src/server/process-lifecycle";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { createCliAgentHarness } from "../../src/server/provider/cli-agent-harness";
import {
  ProviderNdjsonDecoder,
  ProviderRunEventBudget,
} from "../../src/server/provider/io";
import { TerminalManager } from "../../src/server/terminal";
import {
  listWorkspaceEntries,
  searchWorkspaceEntries,
} from "../../src/server/workspace";
import { discoverWorkspaceGitRepositories } from "../../src/server/workspace-git";
import {
  portableNodeExecutable,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "../server/model-route-fixture";

const execFileAsync = promisify(execFile);
const enforce = process.env.INERTIA_BENCHMARK_ENFORCE === "1";
const reportPath = resolve(
  process.env.INERTIA_BENCHMARK_REPORT
    ?? `performance-results/platform-${process.platform}-${process.arch}.json`,
);

interface Measurement {
  medianMs: number;
  minimumMs: number;
  maximumMs: number;
  samples: number[];
  [key: string]: number | number[];
}

async function measured(
  samples: number,
  operation: () => void | Promise<void>,
): Promise<Measurement> {
  await operation();
  const values: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    await operation();
    values.push(performance.now() - startedAt);
  }
  const ordered = [...values].sort((left, right) => left - right);
  return {
    medianMs: Number(ordered[Math.floor(ordered.length / 2)]!.toFixed(3)),
    minimumMs: Number(ordered[0]!.toFixed(3)),
    maximumMs: Number(ordered.at(-1)!.toFixed(3)),
    samples: values.map((value) => Number(value.toFixed(3))),
  };
}

async function sqliteWriteMeasurement(
  root: string,
  workspace: string,
  samples: number,
): Promise<Measurement> {
  const values: number[] = [];
  for (let sample = -1; sample < samples; sample += 1) {
    const databasePath = join(root, `write-sample-${sample}.sqlite`);
    const store = new RuntimeStore(databasePath, workspace, {
      recoverInterruptedRuns: false,
    });
    const project = store.createProject("Benchmark", workspace);
    const conversation = store.createConversation(
      project.id,
      "Benchmark conversation",
    );
    const startedAt = performance.now();
    for (let index = 0; index < 500; index += 1) {
      store.createMessage(
        conversation.id,
        `stream-${randomUUID()}-${"x".repeat(256)}`,
        index % 2 === 0 ? "assistant" : "user",
      );
    }
    const elapsed = performance.now() - startedAt;
    store.close();
    if (sample >= 0) values.push(elapsed);
  }
  const ordered = [...values].sort((left, right) => left - right);
  return {
    medianMs: Number(ordered[Math.floor(ordered.length / 2)]!.toFixed(3)),
    minimumMs: Number(ordered[0]!.toFixed(3)),
    maximumMs: Number(ordered.at(-1)!.toFixed(3)),
    samples: values.map((value) => Number(value.toFixed(3))),
    operationsPerSample: 500,
  };
}

function boundedHostLabel(value: string): string {
  return value.slice(0, 120);
}

async function terminalPtyLifecycleMeasurement(): Promise<Measurement> {
  const samples: number[] = [];
  const frameCounts: number[] = [];
  const outputFrameCounts: number[] = [];
  const outputBytes: number[] = [];
  for (let sample = 0; sample < 3; sample += 1) {
    let frames = 0;
    let outputFrames = 0;
    let bytes = 0;
    let output = "";
    const owner = {
      readyState: 1,
      bufferedAmount: 0,
      send: (payload: string) => {
        frames += 1;
        bytes += Buffer.byteLength(payload);
        const event = JSON.parse(payload) as {
          type: string;
          data?: string;
        };
        if (event.type === "terminal.output" && event.data) {
          outputFrames += 1;
          output += event.data;
        }
      },
    } as unknown as WebSocket;
    const manager = new TerminalManager();
    const startedAt = performance.now();
    await new Promise<void>((resolveExit, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The benchmark PTY did not exit.")),
        10_000,
      );
      manager.createProcess(
        owner,
        process.cwd(),
        process.execPath,
        [
          "-e",
          "for(let i=0;i<2000;i++)process.stdout.write(`line-${i}\\n`)",
        ],
        process.env,
        120,
        40,
        () => {
          clearTimeout(timer);
          resolveExit();
        },
      );
    });
    const expectedLines = Array.from(
      { length: 2_000 },
      (_, index) => `line-${index}`,
    );
    expect(ptyOutputLines(output)).toEqual(expectedLines);
    samples.push(performance.now() - startedAt);
    frameCounts.push(frames);
    outputFrameCounts.push(outputFrames);
    outputBytes.push(bytes);
  }
  const ordered = [...samples].sort((left, right) => left - right);
  return {
    medianMs: Number(ordered[1]!.toFixed(3)),
    minimumMs: Number(ordered[0]!.toFixed(3)),
    maximumMs: Number(ordered[2]!.toFixed(3)),
    samples: samples.map((value) => Number(value.toFixed(3))),
    frameCounts,
    outputFrameCounts,
    outputBytes,
    expectedLinesPerSample: 2_000,
  };
}

function ptyOutputLines(output: string): string[] {
  const withoutTerminalControls = output
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/gu, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "");
  const lines = withoutTerminalControls.split(/\r\n|\r|\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

async function providerHarnessLifecycleMeasurement(root: string): Promise<Measurement> {
  const executable = portableNodeExecutable(root, "benchmark-claude");
  const program = writeNodeSubcommand(root, "benchmark-claude-fixture.cjs", `
const sessionId = "33333333-3333-4333-8333-333333333333";
const send = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
send({ type: "system", subtype: "init", session_id: sessionId });
for (let index = 0; index < 200; index += 1) {
  send({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { text: "chunk-" + index + "|" },
    },
  });
}
send({ type: "result", is_error: false });
`);
  const expectedText = Array.from(
    { length: 200 },
    (_, index) => `chunk-${index}|`,
  ).join("");
  const samples: number[] = [];
  const callbackCounts: number[] = [];
  for (let sample = 0; sample < 3; sample += 1) {
    const conversationId = `provider-benchmark-${sample}`;
    const textEvents: string[] = [];
    const manager = new ProviderManager(
      { commands: { claude: executable } },
      new AgentHarnessRegistry([
        createCliAgentHarness("claude", { prefixArgs: [program] }),
      ]),
    );
    const startedAt = performance.now();
    try {
      const result = await manager.run(nativeProviderRunInput({
        providerId: "claude",
        harnessId: "claude-cli",
        conversationId,
        cwd: root,
        prompt: "Emit the deterministic benchmark stream.",
        interactionMode: "build",
        access: "auto-edit",
      }), {
        onText: ({ text }) => textEvents.push(text),
      });
      const elapsed = performance.now() - startedAt;
      expect(result).toMatchObject({
        status: "completed",
        sessionId: "33333333-3333-4333-8333-333333333333",
        text: expectedText,
      });
      expect(textEvents).toHaveLength(200);
      expect(textEvents.join("")).toBe(expectedText);
      samples.push(elapsed);
      callbackCounts.push(textEvents.length);
    } finally {
      await manager.disposeAll();
    }
  }
  const ordered = [...samples].sort((left, right) => left - right);
  return {
    medianMs: Number(ordered[1]!.toFixed(3)),
    minimumMs: Number(ordered[0]!.toFixed(3)),
    maximumMs: Number(ordered[2]!.toFixed(3)),
    samples: samples.map((value) => Number(value.toFixed(3))),
    streamEventsPerSample: 200,
    callbackCounts,
    normalizedCharactersPerSample: expectedText.length,
  };
}

async function activeProviderStreamMeasurement(): Promise<Measurement> {
  const eventCount = 5_000;
  const serialized = Array.from({ length: eventCount }, (_, index) =>
    JSON.stringify({
      type: "assistant.delta",
      index,
      text: `stream-${index}-${"x".repeat(128)}`,
    })
  ).join("\n") + "\n";
  const source = Buffer.from(serialized);
  let observedEvents = 0;
  const budget = new ProviderRunEventBudget(
    "Benchmark provider",
    4 * 1_024,
    eventCount,
    source.byteLength,
  );
  const decoder = new ProviderNdjsonDecoder(
    4 * 1_024,
    (line) => {
      const event: unknown = JSON.parse(line);
      budget.observe(event);
      observedEvents += 1;
    },
    () => {
      throw new Error("The benchmark provider stream overflowed.");
    },
  );
  const startedAt = performance.now();
  let sourceChunks = 0;
  for (let offset = 0; offset < source.byteLength; offset += 4_093) {
    decoder.push(source.subarray(offset, offset + 4_093));
    sourceChunks += 1;
  }
  decoder.end();
  const elapsed = performance.now() - startedAt;
  expect(observedEvents).toBe(eventCount);
  return {
    medianMs: Number(elapsed.toFixed(3)),
    minimumMs: Number(elapsed.toFixed(3)),
    maximumMs: Number(elapsed.toFixed(3)),
    samples: [Number(elapsed.toFixed(3))],
    events: observedEvents,
    bytes: source.byteLength,
    sourceChunks,
  };
}

async function processTreeLifecycleMeasurement(): Promise<Measurement> {
  const samples: number[] = [];
  const spawnSamples: number[] = [];
  const shutdownSamples: number[] = [];
  for (let sample = 0; sample < 3; sample += 1) {
    const startedAt = performance.now();
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      {
        detached: process.platform !== "win32",
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    try {
      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        child.once("error", rejectSpawn);
        child.once("spawn", resolveSpawn);
      });
      const spawnedAt = performance.now();
      const stopped = await terminateProcessTreeAndWait(child, true, {
        waitMs: 5_000,
      });
      const stoppedAt = performance.now();
      expect(stopped).toBe(true);
      spawnSamples.push(spawnedAt - startedAt);
      shutdownSamples.push(stoppedAt - spawnedAt);
      samples.push(stoppedAt - startedAt);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }
  const ordered = [...samples].sort((left, right) => left - right);
  const orderedSpawn = [...spawnSamples].sort((left, right) => left - right);
  const orderedShutdown = [...shutdownSamples].sort((left, right) => left - right);
  return {
    medianMs: Number(ordered[1]!.toFixed(3)),
    minimumMs: Number(ordered[0]!.toFixed(3)),
    maximumMs: Number(ordered[2]!.toFixed(3)),
    samples: samples.map((value) => Number(value.toFixed(3))),
    spawnMedianMs: Number(orderedSpawn[1]!.toFixed(3)),
    shutdownMedianMs: Number(orderedShutdown[1]!.toFixed(3)),
    confirmedStops: samples.length,
  };
}

async function gitCommit(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: process.cwd(), encoding: "utf8", timeout: 2_000 },
    );
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

async function createWorkspaceFixture(root: string): Promise<void> {
  const writes: Array<Promise<void>> = [];
  for (let directoryIndex = 0; directoryIndex < 40; directoryIndex += 1) {
    const directory = join(root, `package-${String(directoryIndex).padStart(3, "0")}`, "src");
    await mkdir(directory, { recursive: true });
    for (let fileIndex = 0; fileIndex < 12; fileIndex += 1) {
      writes.push(writeFile(
        join(directory, `module-${String(fileIndex).padStart(3, "0")}.ts`),
        `export const value = ${fileIndex};\n`,
      ));
    }
  }
  for (let fileIndex = 0; fileIndex < 500; fileIndex += 1) {
    writes.push(writeFile(
      join(root, `root-${String(fileIndex).padStart(4, "0")}.txt`),
      `fixture ${fileIndex}\n`,
    ));
  }
  await Promise.all(writes);
}

async function initializeRepository(path: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: path });
  await writeFile(join(path, "tracked.txt"), "tracked\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: path });
  await execFileAsync("git", [
    "-c",
    "user.name=Inertia Benchmark",
    "-c",
    "user.email=benchmark@inertia.local",
    "commit",
    "-qm",
    "fixture",
  ], { cwd: path });
  await writeFile(join(path, "tracked.txt"), "tracked\nchanged\n");
}

function fakePty(): {
  emitData: (data: string) => void;
  pty: IPty;
} {
  const dataListeners = new Set<(data: string) => void>();
  const disposable = <T>(listeners: Set<T>, callback: T): IDisposable => ({
    dispose: () => listeners.delete(callback),
  });
  const pty = {
    pid: 42,
    onData: (callback: (data: string) => void) => {
      dataListeners.add(callback);
      return disposable(dataListeners, callback);
    },
    onExit: () => ({ dispose: () => undefined }),
    kill: () => undefined,
    write: () => undefined,
    resize: () => undefined,
  } as unknown as IPty;
  return {
    emitData: (data) => {
      for (const listener of dataListeners) listener(data);
    },
    pty,
  };
}

function terminalBurstMeasurement(): Promise<Measurement> {
  const terminal = fakePty();
  let frames = 0;
  let bytes = 0;
  const owner = {
    readyState: 1,
    bufferedAmount: 0,
    send: (payload: string) => {
      frames += 1;
      bytes += Buffer.byteLength(payload);
    },
  } as unknown as WebSocket;
  const manager = new TerminalManager({
    spawnTerminal: () => terminal.pty,
    terminateProcessTree: async () => true,
  });
  manager.createProcess(
    owner,
    process.cwd(),
    "benchmark-terminal",
    [],
    {},
    120,
    40,
  );
  const startedAt = performance.now();
  for (let index = 0; index < 10_000; index += 1) {
    terminal.emitData(`${index % 10}`);
  }
  return new Promise((resolveMeasurement) => {
    setTimeout(() => {
      const elapsed = performance.now() - startedAt;
      resolveMeasurement({
        medianMs: Number(elapsed.toFixed(3)),
        minimumMs: Number(elapsed.toFixed(3)),
        maximumMs: Number(elapsed.toFixed(3)),
        samples: [Number(elapsed.toFixed(3))],
        frames,
        bytes,
        sourceChunks: 10_000,
      });
    }, 30);
  });
}

describe("cross-platform performance benchmark", () => {
  it("reconstructs ordered PTY records across platform newline conventions", () => {
    expect(ptyOutputLines("line-0\rline-1\r")).toEqual([
      "line-0",
      "line-1",
    ]);
    expect(ptyOutputLines("line-0\r\nline-1\r\n")).toEqual([
      "line-0",
      "line-1",
    ]);
    expect(ptyOutputLines("line-0\nline-1\rline-2\r\nline-3\n")).toEqual([
      "line-0",
      "line-1",
      "line-2",
      "line-3",
    ]);
    expect(ptyOutputLines(
      "\u001B[?9001h\u001B[?1004h\u001B[?25lline-0\r\n"
      + "\u001B]0;C:\\node\\node.exe\u0007\u001B[?25hline-1\r\n",
    )).toEqual(["line-0", "line-1"]);
    expect(ptyOutputLines("line-0\nline-2\n")).not.toEqual([
      "line-0",
      "line-1",
      "line-2",
    ]);
    expect(ptyOutputLines("line-0\nline-2\nline-1\n")).not.toEqual([
      "line-0",
      "line-1",
      "line-2",
    ]);
    expect(ptyOutputLines("line-0line-1\n")).not.toEqual([
      "line-0",
      "line-1",
    ]);
    expect(ptyOutputLines("printable-prefixline-0\nline-1\n")).not.toEqual([
      "line-0",
      "line-1",
    ]);
  });

  it("records bounded product-path measurements and host metadata", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "inertia-platform-benchmark-"));
    try {
      const workspace = join(fixtureRoot, "workspace");
      await mkdir(workspace);
      await createWorkspaceFixture(workspace);

      const workspaceList = await measured(5, async () => {
        const result = await listWorkspaceEntries(workspace, "", { maxEntries: 1_000 });
        expect(result.entries).toHaveLength(540);
      });
      const workspaceSearch = await measured(5, async () => {
        const result = await searchWorkspaceEntries(workspace, "module-011", {
          maxResults: 250,
          maxVisitedEntries: 20_000,
        });
        expect(result.entries).toHaveLength(40);
      });

      const gitWorkspace = join(fixtureRoot, "git-workspace");
      await mkdir(gitWorkspace);
      await initializeRepository(gitWorkspace);
      for (let index = 0; index < 8; index += 1) {
        const repository = join(gitWorkspace, `nested-${index}`);
        await mkdir(repository);
        await initializeRepository(repository);
      }
      const gitScan = await measured(3, async () => {
        const result = await discoverWorkspaceGitRepositories(gitWorkspace, {
          maxDepth: 3,
          maxDirectories: 500,
          maxRepositories: 32,
          statusConcurrency: 4,
        });
        expect(result.repositories).toHaveLength(9);
      });

      const databasePath = join(fixtureRoot, "runtime", "inertia.sqlite");
      await mkdir(dirname(databasePath), { recursive: true });
      const coldStartedAt = performance.now();
      let store = new RuntimeStore(databasePath, workspace, {
        recoverInterruptedRuns: false,
      });
      const sqliteColdOpenMs = performance.now() - coldStartedAt;
      store.close();
      const sqliteWrites = await sqliteWriteMeasurement(
        join(fixtureRoot, "runtime"),
        workspace,
        3,
      );
      const sqliteWarmOpen = await measured(5, () => {
        store = new RuntimeStore(databasePath, workspace, {
          recoverInterruptedRuns: false,
        });
        store.close();
      });

      const processSpawn = await measured(7, async () => {
        await execFileAsync(process.execPath, ["-e", "process.exit(0)"], {
          timeout: 5_000,
          windowsHide: true,
        });
      });
      const activeProviderStream = await activeProviderStreamMeasurement();
      const providerHarnessLifecycle = await providerHarnessLifecycleMeasurement(
        fixtureRoot,
      );
      const processTreeLifecycle = await processTreeLifecycleMeasurement();
      const terminalBurst = await terminalBurstMeasurement();
      const terminalPtyLifecycle = await terminalPtyLifecycleMeasurement();

      const cpu = cpus();
      const report = {
        schemaVersion: 1,
        benchmarkId: randomUUID(),
        collectedAt: new Date().toISOString(),
        commit: await gitCommit(),
        enforced: enforce,
        runtime: {
          node: process.version,
          v8: process.versions.v8,
          napi: process.versions.napi,
        },
        host: {
          platform: platform(),
          architecture: arch(),
          osType: type(),
          osRelease: release(),
          osVersion: version(),
          homeVolumeKind: homedir().startsWith("/Volumes/")
            ? "mounted-volume"
            : "system-volume",
          cpuModel: boundedHostLabel(cpu[0]?.model ?? "unknown"),
          logicalCpuCount: cpu.length,
          nominalCpuMHz: cpu[0]?.speed ?? 0,
          totalMemoryBytes: totalmem(),
          freeMemoryBytes: freemem(),
          ci: process.env.CI === "true",
          displayServer: process.env.XDG_SESSION_TYPE ?? null,
          waylandDisplay: process.env.WAYLAND_DISPLAY ? "present" : "absent",
          x11Display: process.env.DISPLAY ? "present" : "absent",
        },
        scenarios: {
          workspaceList,
          workspaceSearch,
          gitScan,
          sqliteColdOpen: {
            medianMs: Number(sqliteColdOpenMs.toFixed(3)),
            minimumMs: Number(sqliteColdOpenMs.toFixed(3)),
            maximumMs: Number(sqliteColdOpenMs.toFixed(3)),
            samples: [Number(sqliteColdOpenMs.toFixed(3))],
            cacheState: "fresh database; operating-system cache uncontrolled",
          },
          sqliteWrites,
          sqliteWarmOpen,
          processSpawn,
          activeProviderStream,
          providerHarnessLifecycle,
          processTreeLifecycle,
          terminalBurst,
          terminalPtyLifecycle,
        },
      };

      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });

      expect(report.runtime.node).toMatch(/^v22\./u);
      expect(workspaceList.medianMs).toBeGreaterThan(0);
      expect(workspaceSearch.medianMs).toBeGreaterThan(0);
      expect(gitScan.medianMs).toBeGreaterThan(0);
      expect(sqliteWrites.medianMs).toBeGreaterThan(0);
      expect(processSpawn.medianMs).toBeGreaterThan(0);
      expect(terminalBurst.frames).toBeGreaterThan(0);

      if (enforce) {
        expect(workspaceList.medianMs).toBeLessThan(8_000);
        expect(workspaceSearch.medianMs).toBeLessThan(8_000);
        expect(gitScan.medianMs).toBeLessThan(20_000);
        expect(sqliteColdOpenMs).toBeLessThan(10_000);
        expect(sqliteWarmOpen.medianMs).toBeLessThan(5_000);
        expect(sqliteWrites.medianMs).toBeLessThan(15_000);
        expect(processSpawn.medianMs).toBeLessThan(5_000);
        expect(activeProviderStream.medianMs).toBeLessThan(5_000);
        expect(providerHarnessLifecycle.medianMs).toBeLessThan(10_000);
        expect(processTreeLifecycle.medianMs).toBeLessThan(10_000);
        expect(processTreeLifecycle.confirmedStops).toBe(3);
        expect(terminalBurst.medianMs).toBeLessThan(2_000);
        expect(terminalBurst.frames).toBeLessThanOrEqual(64);
        expect(terminalPtyLifecycle.medianMs).toBeLessThan(10_000);
      }
    } finally {
      await rm(fixtureRoot, {
        recursive: true,
        force: true,
        ...(process.platform === "win32"
          ? { maxRetries: 8, retryDelay: 100 }
          : {}),
      });
    }
  });
});
