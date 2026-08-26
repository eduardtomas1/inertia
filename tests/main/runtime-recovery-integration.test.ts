import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readdir } from "node:fs/promises";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeSupervisor } from "../../src/main/runtime-supervisor";
import type { RuntimeWorkerCommand } from "../../src/node/runtime-process-protocol";
import { RuntimeStore } from "../../src/server/database";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const temporaryDirectories: string[] = [];
const activeChildren = new Set<ChildProcess>();

class NodeUtilityProcess extends EventEmitter {
  readonly child: ChildProcess;
  readonly stderr: string[] = [];

  constructor(workerPath: string) {
    super();
    this.child = spawn(
      process.execPath,
      [join(repositoryRoot, "tests", "fixtures", "runtime-worker-node-host.mjs")],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          NODE_ENV: "test",
          INERTIA_RECOVERY_TEST_WORKER: workerPath,
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    activeChildren.add(this.child);
    this.child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      this.stderr.push(chunk);
    });
    this.child.once("spawn", () => this.emit("spawn"));
    this.child.on("message", (message) => this.emit("message", message));
    this.child.once("error", (error) => {
      this.emit("error", "node-host", error.message);
    });
    this.child.once("exit", (code) => {
      activeChildren.delete(this.child);
      this.emit("exit", code ?? 1);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  postMessage(message: RuntimeWorkerCommand): void {
    this.child.send?.(message);
  }

  kill(): boolean {
    return this.child.kill("SIGKILL");
  }
}

afterEach(() => {
  for (const child of activeChildren) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  activeChildren.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function waitFor(
  predicate: () => boolean,
  description: string,
  diagnostics: () => string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}. ${diagnostics()}`);
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
}

function markerGatedRequestTimer(markerPath: string): typeof setTimeout {
  let recoveryDeadlineCount = 0;
  return ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay !== 1) return setTimeout(callback, delay, ...args);
    recoveryDeadlineCount += 1;
    if (recoveryDeadlineCount > 1) {
      return setTimeout(callback, 10_000, ...args);
    }
    // Arm the request deadline only after the isolated import worker proves
    // it owns the transaction. Cold worker startup is not part of the
    // cancellation behavior under test.
    const timer = setInterval(() => {
      if (!existsSync(markerPath)) return;
      clearInterval(timer);
      callback(...args);
    }, 10);
    return timer;
  }) as typeof setTimeout;
}

function buildRuntimeWorkers(): string {
  const buildDirectory = mkdtempSync(join(repositoryRoot, ".recovery-integration-"));
  temporaryDirectories.push(buildDirectory);
  const runtimeWorkerPath = join(buildDirectory, "runtime-worker.js");
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "import { build } from 'esbuild'; await build(JSON.parse(process.argv[1]));",
      JSON.stringify({
        entryPoints: {
          "runtime-worker": join(repositoryRoot, "src", "server", "runtime-worker.ts"),
          "database-recovery-import-worker": join(
            repositoryRoot,
            "src",
            "server",
            "persistence",
            "database-recovery-import-worker.ts",
          ),
        },
        outdir: buildDirectory,
        bundle: true,
        packages: "external",
        platform: "node",
        format: "esm",
        target: "node22",
      }),
    ],
    { cwd: repositoryRoot, stdio: "pipe" },
  );
  expect(existsSync(runtimeWorkerPath)).toBe(true);
  expect(existsSync(join(
    buildDirectory,
    "database-recovery-import-worker.js",
  ))).toBe(true);
  return runtimeWorkerPath;
}

describe("runtime recovery supervisor integration", () => {
  it("force-terminates a post-rename import and keeps replacement mutations locked", async () => {
    const testRoot = mkdtempSync(join(tmpdir(), "inertia-recovery-supervisor-"));
    temporaryDirectories.push(testRoot);
    const dataDirectory = join(testRoot, "data");
    const workspaceDirectory = join(testRoot, "workspace");
    const targetDirectory = join(testRoot, "recovered");
    mkdirSync(dataDirectory, { mode: 0o700 });
    mkdirSync(workspaceDirectory, { mode: 0o700 });
    mkdirSync(targetDirectory, { mode: 0o700 });
    const recoveryPath = join(testRoot, "recovery.json");
    const markerPath = join(testRoot, "after-publish.marker");
    writeFileSync(recoveryPath, JSON.stringify({
      format: "inertia-recovery-export",
      version: 1,
      exportedAt: "2026-08-02T08:00:00.000Z",
      projects: [
        {
          name: "Recovered one",
          path: process.platform === "win32" ? "C:\\source\\one" : "/source/one",
          conversations: [],
        },
        {
          name: "Recovered two",
          path: process.platform === "win32" ? "C:\\source\\two" : "/source/two",
          conversations: [],
        },
      ],
    }), { encoding: "utf8", mode: 0o600 });
    const runtimeWorkerPath = buildRuntimeWorkers();

    const children: NodeUtilityProcess[] = [];
    const states: string[] = [];
    const markerGatedSetTimer = markerGatedRequestTimer(markerPath);
    const supervisor = new RuntimeSupervisor({
      workerOptions: {
        dataDirectory,
        defaultWorkspacePath: workspaceDirectory,
        enableProviders: false,
        ...(process.platform === "darwin"
          ? {
              runtimeProcessGuardianPath: join(
                process.cwd(),
                "resources/generated/runtime-process-guardian/runtime-process-guardian",
              ),
            }
          : {}),
        recoveryImportFault: {
          phase: "after-staging-publish",
          markerPath,
          stallMs: 30_000,
        },
      },
      spawn: () => {
        const child = new NodeUtilityProcess(runtimeWorkerPath);
        children.push(child);
        return child as never;
      },
      startupTimeoutMs: 10_000,
      stableUptimeMs: 30_000,
      shutdownGraceMs: 2_000,
      forceKillWaitMs: 1_000,
      setTimer: markerGatedSetTimer,
      databaseRecoveryRequestTimeoutMs: 1,
      databaseRecoveryCancelTimeoutMs: 250,
      onStateChange: ({ phase, generation, pid }) => {
        states.push(`${phase}:${generation}:${pid ?? 0}`);
      },
    });
    const diagnostics = () => JSON.stringify({
      states,
      stderr: children.flatMap(({ stderr }) => stderr),
    });
    supervisor.start();
    await waitFor(
      () => supervisor.snapshot().phase === "ready"
        && supervisor.snapshot().generation === 1,
      "first runtime generation readiness",
      diagnostics,
    );

    const first = supervisor.databaseRecovery(
      "import",
      recoveryPath,
      targetDirectory,
    );
    await waitFor(
      () => existsSync(markerPath),
      "post-rename import fault marker",
      diagnostics,
    );
    await expect(first).rejects.toThrow(
      /timed out.*before cancellation was confirmed/u,
    );
    expect(existsSync(markerPath)).toBe(true);
    await waitFor(
      () => supervisor.snapshot().phase === "ready"
        && supervisor.snapshot().generation === 2,
      "replacement runtime generation readiness",
      diagnostics,
    );
    expect(readFileSync(markerPath, "utf8")).toBe("staging-published\n");
    expect(readFileSync(recoveryPath, "utf8")).toContain("Recovered one");
    expect(existsSync(targetDirectory)).toBe(true);
    await expect(readdir(targetDirectory)).resolves.toEqual([]);

    await expect(supervisor.databaseRecovery(
      "import",
      recoveryPath,
      targetDirectory,
    )).rejects.toThrow(/recovery safety mode.*prior runtime-owned process/iu);
    expect(supervisor.snapshot()).toMatchObject({ phase: "ready", generation: 2 });
    await expect(supervisor.stop()).resolves.toBe(false);
  }, 30_000);

  it("cancels a near-limit import while its isolated transaction is busy", async () => {
    const testRoot = mkdtempSync(join(tmpdir(), "inertia-recovery-cancel-"));
    temporaryDirectories.push(testRoot);
    const dataDirectory = join(testRoot, "data");
    const workspaceDirectory = join(testRoot, "workspace");
    const targetDirectory = join(testRoot, "recovered");
    mkdirSync(dataDirectory, { mode: 0o700 });
    mkdirSync(workspaceDirectory, { mode: 0o700 });
    mkdirSync(targetDirectory, { mode: 0o700 });
    const recoveryPath = join(testRoot, "near-limit-recovery.json");
    const markerPath = join(testRoot, "message-import.marker");
    const message = {
      role: "assistant",
      content: "bounded",
      createdAt: "2026-08-02T08:00:00.000Z",
    };
    writeFileSync(recoveryPath, JSON.stringify({
      format: "inertia-recovery-export",
      version: 1,
      exportedAt: "2026-08-02T08:00:00.000Z",
      projects: [{
        name: "Near limit",
        path: process.platform === "win32" ? "C:\\source\\large" : "/source/large",
        conversations: [{
          title: "Near limit",
          providerId: "codex",
          model: "gpt-test",
          reasoningEffort: "high",
          interactionMode: "build",
          accessMode: "supervised",
          messages: Array.from({ length: 249_000 }, () => message),
        }],
      }],
    }), { encoding: "utf8", mode: 0o600 });
    const runtimeWorkerPath = buildRuntimeWorkers();
    const children: NodeUtilityProcess[] = [];
    const states: string[] = [];
    const markerGatedSetTimer = markerGatedRequestTimer(markerPath);
    const supervisor = new RuntimeSupervisor({
      workerOptions: {
        dataDirectory,
        defaultWorkspacePath: workspaceDirectory,
        enableProviders: false,
        ...(process.platform === "darwin"
          ? {
              runtimeProcessGuardianPath: join(
                process.cwd(),
                "resources/generated/runtime-process-guardian/runtime-process-guardian",
              ),
            }
          : {}),
        recoveryImportFault: {
          phase: "during-message-import",
          markerPath,
          stallMs: 30_000,
        },
      },
      spawn: () => {
        const child = new NodeUtilityProcess(runtimeWorkerPath);
        children.push(child);
        return child as never;
      },
      startupTimeoutMs: 10_000,
      stableUptimeMs: 30_000,
      shutdownGraceMs: 2_000,
      forceKillWaitMs: 1_000,
      setTimer: markerGatedSetTimer,
      databaseRecoveryRequestTimeoutMs: 1,
      databaseRecoveryCancelTimeoutMs: 2_000,
      onStateChange: ({ phase, generation, pid }) => {
        states.push(`${phase}:${generation}:${pid ?? 0}`);
      },
    });
    const diagnostics = () => JSON.stringify({
      states,
      stderr: children.flatMap(({ stderr }) => stderr),
    });
    supervisor.start();
    await waitFor(
      () => supervisor.snapshot().phase === "ready",
      "runtime readiness",
      diagnostics,
    );

    const pending = supervisor.databaseRecovery(
      "import",
      recoveryPath,
      targetDirectory,
    );
    const timedOutAndCancelled = expect(pending).rejects.toThrow(
      /timed out and was cancelled/u,
    );
    await waitFor(
      () => existsSync(markerPath),
      "busy import transaction marker",
      diagnostics,
    );
    await timedOutAndCancelled;
    expect(supervisor.snapshot()).toMatchObject({ phase: "ready", generation: 1 });
    expect(readdirSync(targetDirectory)).toEqual([]);

    const assertNoLateCommit = (): void => {
      const database = new Database(join(dataDirectory, "inertia.sqlite"), {
        readonly: true,
      });
      expect(database.prepare(`
        SELECT
          (SELECT COUNT(*) FROM projects) AS projects,
          (SELECT COUNT(*) FROM messages) AS messages,
          (SELECT COUNT(*) FROM recovery_import_receipts) AS receipts,
          (SELECT COUNT(*) FROM recovery_import_journals) AS journals
      `).get()).toEqual({ projects: 0, messages: 0, receipts: 0, journals: 0 });
      database.close();
    };
    assertNoLateCommit();
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 250));
    assertNoLateCommit();
    await expect(supervisor.stop()).resolves.toBe(true);
  }, 30_000);

  it("rejects import while a background provider run remains active", async () => {
    const testRoot = mkdtempSync(join(tmpdir(), "inertia-recovery-active-run-"));
    temporaryDirectories.push(testRoot);
    const dataDirectory = join(testRoot, "data");
    const workspaceDirectory = join(testRoot, "workspace");
    const targetDirectory = join(testRoot, "recovered");
    mkdirSync(dataDirectory, { mode: 0o700 });
    mkdirSync(workspaceDirectory, { mode: 0o700 });
    mkdirSync(targetDirectory, { mode: 0o700 });
    const recoveryPath = join(testRoot, "recovery.json");
    writeFileSync(recoveryPath, JSON.stringify({
      format: "inertia-recovery-export",
      version: 1,
      exportedAt: "2026-08-02T08:00:00.000Z",
      projects: [],
    }), { encoding: "utf8", mode: 0o600 });
    const seeded = new RuntimeStore(
      join(dataDirectory, "inertia.sqlite"),
      workspaceDirectory,
      { recoverInterruptedRuns: false },
    );
    const project = seeded.createProject("Active", workspaceDirectory);
    const conversation = seeded.createConversation(project.id, "Active provider");
    seeded.close();

    const runtimeWorkerPath = buildRuntimeWorkers();
    const children: NodeUtilityProcess[] = [];
    const supervisor = new RuntimeSupervisor({
      workerOptions: {
        dataDirectory,
        defaultWorkspacePath: workspaceDirectory,
        enableProviders: false,
        ...(process.platform === "darwin"
          ? {
              runtimeProcessGuardianPath: join(
                process.cwd(),
                "resources/generated/runtime-process-guardian/runtime-process-guardian",
              ),
            }
          : {}),
      },
      spawn: () => {
        const child = new NodeUtilityProcess(runtimeWorkerPath);
        children.push(child);
        return child as never;
      },
      startupTimeoutMs: 10_000,
      shutdownGraceMs: 2_000,
      forceKillWaitMs: 1_000,
    });
    const diagnostics = () => JSON.stringify({
      stderr: children.flatMap(({ stderr }) => stderr),
      snapshot: supervisor.snapshot(),
    });
    supervisor.start();
    await waitFor(
      () => supervisor.snapshot().phase === "ready",
      "runtime readiness",
      diagnostics,
    );
    // Insert after startup reconciliation to model a provider callback that
    // still owns a live run after the command that launched it has returned.
    const active = new RuntimeStore(
      join(dataDirectory, "inertia.sqlite"),
      workspaceDirectory,
      { recoverInterruptedRuns: false },
    );
    active.createWorkspaceRun({
      kind: "agent",
      projectId: project.id,
      conversationId: conversation.id,
      label: "Active provider",
      detail: "Streaming",
      status: "running",
      port: null,
    });
    active.close();

    await expect(supervisor.databaseRecovery(
      "import",
      recoveryPath,
      targetDirectory,
    )).rejects.toThrow(/while runtime work is active/u);
    expect(readdirSync(targetDirectory)).toEqual([]);
    const database = new Database(join(dataDirectory, "inertia.sqlite"), {
      readonly: true,
    });
    expect(database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM recovery_import_receipts) AS receipts,
        (SELECT COUNT(*) FROM recovery_import_journals) AS journals
    `).get()).toEqual({ receipts: 0, journals: 0 });
    database.close();
    await expect(supervisor.stop()).resolves.toBe(true);
  }, 30_000);
});
