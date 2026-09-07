import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker, WorkerOptions } from "node:worker_threads";

import Database from "better-sqlite3";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { runRecoveryImportWorker } from "../../src/server/persistence/database-recovery-import-worker-client";
import {
  parseRecoveryImportWorkerEvent,
  parseRecoveryImportWorkerRequest,
} from "../../src/server/persistence/database-recovery-import-worker-protocol";

const transport = vi.hoisted(() => ({
  workerPath: "",
  source: null as string | null,
  workers: [] as Worker[],
}));

// Redirect only the entry point. Messages, structured clone, error/exit events,
// termination and thread lifetime still use a real Node Worker.
vi.mock("node:worker_threads", async (original) => {
  const actual = await original<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(_entry: URL, options: WorkerOptions) {
        super(transport.source ?? transport.workerPath, {
          ...options,
          ...(transport.source === null ? {} : { eval: true }),
        });
        transport.workers.push(this);
      }
    },
  };
});

const operationId = "fbc0bc2e-1c69-4d1a-96bb-6e644eb3ed28";
const receipt = { projects: 1, conversations: 0, messages: 0, alreadyImported: false };
const event = { type: "recovery-import.result", version: 1, operationId, ok: true, result: receipt };
const temporaryDirectories: string[] = [];
let fixtureRoot: string;

beforeAll(async () => {
  // Keep the bundle beside node_modules, just like the shipped worker.
  const bundleRoot = mkdtempSync(join(process.cwd(), ".recovery-worker-test-"));
  temporaryDirectories.push(bundleRoot);
  transport.workerPath = join(bundleRoot, "worker.mjs");
  await build({
    entryPoints: ["src/server/persistence/database-recovery-import-worker.ts"],
    outfile: transport.workerPath,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "node22",
  });
});

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "inertia-recovery-worker-"));
  temporaryDirectories.push(fixtureRoot);
  transport.source = null;
});

afterEach(async () => {
  await Promise.all(transport.workers.map((worker) => worker.terminate()));
  transport.workers.length = 0;
});

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function options() {
  const workspace = join(fixtureRoot, "workspace");
  const targetDirectory = join(fixtureRoot, "target");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(targetDirectory, { recursive: true });
  return {
    databasePath: join(fixtureRoot, "runtime.sqlite"),
    defaultWorkspacePath: workspace,
    recoveryPath: join(fixtureRoot, "recovery.json"),
    targetDirectory,
    operationId,
  };
}

describe("recovery import worker transport", () => {
  it.each([
    null,
    { data: event },
    { ...event, version: 2 },
    { ...event, operationId: "ddc0bc2e-1c69-4d1a-96bb-6e644eb3ed28" },
    { ...event, extra: "private detail" },
    { ...event, result: { ...receipt, projects: -1 } },
    { ...event, result: { ...receipt, messages: 250_001 } },
    { ...event, ok: false, message: "private path or error" },
  ])("rejects malformed or foreign real-thread receipts and drains the writer: %j", async (message) => {
    transport.source = `
      const { parentPort } = require("node:worker_threads");
      parentPort.postMessage(${JSON.stringify(message)});
      setInterval(() => {}, 1000);
    `;
    await expect(runRecoveryImportWorker(options())).rejects.toThrow(
      "The recovery import worker returned an invalid receipt.",
    );
    expect(transport.workers).toHaveLength(1);
    expect(transport.workers[0]!.threadId).toBe(-1);
    expect(transport.workers[0]!.eventNames()).toEqual([]);
  });

  it("rejects duplicate receipts without letting a later message overwrite the first", async () => {
    transport.source = `
      const { parentPort } = require("node:worker_threads");
      parentPort.postMessage(${JSON.stringify(event)});
      parentPort.postMessage(${JSON.stringify({ ...event, result: { ...receipt, projects: 2 } })});
      setInterval(() => {}, 1000);
    `;
    await expect(runRecoveryImportWorker(options())).rejects.toThrow("invalid receipt");
    expect(transport.workers[0]!.threadId).toBe(-1);
  });

  it("keeps a validated committed receipt authoritative when cancellation races worker exit", async () => {
    const abort = new AbortController();
    transport.source = `
      const { parentPort } = require("node:worker_threads");
      parentPort.postMessage(${JSON.stringify(event)});
      parentPort.once("message", () => parentPort.close());
    `;
    let settled = false;
    const pending = runRecoveryImportWorker({ ...options(), signal: abort.signal }).then((value) => {
      settled = true;
      return value;
    });
    const worker = transport.workers[0]!;
    await new Promise<void>((resolve) => worker.once("message", () => {
      abort.abort();
      resolve();
    }));
    expect(settled).toBe(false);
    expect(worker.threadId).not.toBe(-1);
    worker.postMessage("allow-fixture-exit");
    await expect(pending).resolves.toEqual(receipt);
    expect(worker.threadId).toBe(-1);
  });

  it("imports through the production worker and resolves only after SQLite and the thread close", async () => {
    const input = options();
    writeFileSync(input.recoveryPath, JSON.stringify({
      format: "inertia-recovery-export",
      version: 1,
      exportedAt: "2026-09-07T00:00:00.000Z",
      projects: [{ name: "Synthetic project", path: input.defaultWorkspacePath, conversations: [] }],
    }));
    const pending = runRecoveryImportWorker(input);
    const messages: unknown[] = [];
    transport.workers[0]!.on("message", (message: unknown) => messages.push(message));
    await expect(pending).resolves.toEqual(receipt);
    expect(messages).toEqual([event]);
    expect(transport.workers[0]!.threadId).toBe(-1);
    const database = new Database(input.databasePath);
    try {
      database.exec("BEGIN EXCLUSIVE; ROLLBACK;");
    } finally {
      database.close();
    }
  });

  it("does not authorize reconciliation when termination rejects before the writer exits", async () => {
    transport.source = `
      const { parentPort } = require("node:worker_threads");
      parentPort.postMessage(null);
      parentPort.once("message", () => parentPort.close());
    `;
    let settled = false;
    const pending = runRecoveryImportWorker(options()).finally(() => { settled = true; });
    // Observe rejection immediately without letting the test auto-settle it.
    const rejection = expect(pending).rejects.toThrow("invalid receipt");
    const worker = transport.workers[0]!;
    const termination = vi.spyOn(worker, "terminate").mockRejectedValueOnce(new Error("unconfirmed"));
    await new Promise<void>((resolve) => worker.once("message", () => resolve()));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(termination).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(worker.threadId).not.toBe(-1);
    worker.postMessage("allow-fixture-exit");
    await rejection;
    expect(worker.threadId).toBe(-1);
  });

  it("preserves an exact committed receipt even when its subsequent exit code is nonzero", async () => {
    transport.source = `
      const { parentPort } = require("node:worker_threads");
      parentPort.postMessage(${JSON.stringify(event)});
      process.exitCode = 7;
    `;
    await expect(runRecoveryImportWorker(options())).resolves.toEqual(receipt);
    expect(transport.workers[0]!.threadId).toBe(-1);
  });

  it("returns only a fixed failure code for private worker errors", async () => {
    const pending = runRecoveryImportWorker(options());
    const messages: unknown[] = [];
    transport.workers[0]!.on("message", (message: unknown) => messages.push(message));
    await expect(pending).rejects.toThrow("The database recovery import failed.");
    expect(messages).toEqual([{
      type: "recovery-import.result", version: 1, operationId, ok: false, code: "import-failed",
    }]);
    expect(JSON.stringify(messages)).not.toContain(fixtureRoot);
    expect(transport.workers[0]!.threadId).toBe(-1);
  });

  it("bounds and validates the privileged request before creating a worker", async () => {
    const input = options();
    const request = { ...input, type: "recovery-import.start", version: 1 };
    expect(parseRecoveryImportWorkerRequest(request)).toEqual(request);
    expect(parseRecoveryImportWorkerRequest({ ...request, databasePath: "relative.sqlite" })).toBeNull();
    expect(parseRecoveryImportWorkerRequest({ ...request, recoveryPath: "x".repeat(4_097) })).toBeNull();
    expect(parseRecoveryImportWorkerRequest({ ...request, extra: true })).toBeNull();
    await expect(runRecoveryImportWorker({ ...input, operationId: "foreign" })).rejects.toThrow("request is invalid");
    expect(transport.workers).toHaveLength(0);
    expect(parseRecoveryImportWorkerEvent({ ...event, ok: false, code: "private error" })).toBeNull();
  });

  it("rejects malformed workerData at the real worker boundary without opening a database", async () => {
    const { Worker: NativeWorker } = await vi.importActual<typeof import("node:worker_threads")>(
      "node:worker_threads",
    );
    const worker = new NativeWorker(transport.workerPath, { workerData: null });
    transport.workers.push(worker);
    const errors: string[] = [];
    worker.on("error", (error: Error) => errors.push(error.message));
    const exitCode = await new Promise<number>((resolve) => worker.once("exit", resolve));
    expect(exitCode).toBe(1);
    expect(errors).toEqual(["The recovery import worker request is invalid."]);
    expect(worker.threadId).toBe(-1);
    expect(readdirSync(fixtureRoot)).toEqual([]);
  });
});
