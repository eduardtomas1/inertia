import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createAppFixture } from "./support/app-fixture";

interface WorkerProbe {
  cwd: string;
  request: Record<string, unknown>;
  terminalType: string;
  workerPath: string;
}

function identity(value: Awaited<ReturnType<typeof lstat>>): {
  dev: string;
  ino: string;
} {
  return { dev: String(value.dev), ino: String(value.ino) };
}

test("one-shot utility workers await an exact terminal-result acknowledgement", async () => {
  const app = await createAppFixture({
    name: "utility-worker-result-ack",
    initialState: "empty",
  });
  try {
    const transportRoot = join(app.testDirectory, "utility-ack-transport");
    const attachmentRoot = join(transportRoot, "conversation-attachments");
    const importRoot = join(transportRoot, "attachment-import");
    const secureRoot = join(transportRoot, "secure-files");
    await Promise.all([
      mkdir(attachmentRoot, { recursive: true, mode: 0o700 }),
      mkdir(importRoot, { recursive: true, mode: 0o700 }),
      mkdir(secureRoot, { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([
      chmod(attachmentRoot, 0o700),
      chmod(importRoot, 0o700),
      chmod(secureRoot, 0o700),
    ]);

    const stagedName = `${randomUUID()}.png`;
    const stagedPath = join(importRoot, stagedName);
    await copyFile(app.attachmentImagePath, stagedPath);
    await chmod(stagedPath, 0o600);
    const secureName = "example.txt";
    const securePath = join(secureRoot, secureName);
    await writeFile(securePath, "secure worker transport probe\n", { mode: 0o600 });
    await chmod(securePath, 0o600);

    const [attachmentCanonical, importCanonical, secureCanonical] =
      await Promise.all([
        realpath(attachmentRoot),
        realpath(importRoot),
        realpath(secureRoot),
      ]);
    const [attachmentRootStat, importRootStat, stagedStat, secureRootStat,
      secureStat] = await Promise.all([
      lstat(attachmentRoot),
      lstat(importRoot),
      lstat(stagedPath),
      lstat(secureRoot),
      lstat(securePath),
    ]);
    const uid = process.platform === "win32" ? null : String(process.getuid?.());
    const probes: WorkerProbe[] = [
      {
        workerPath: resolve("out/main/conversation-attachment-store-worker.js"),
        cwd: attachmentCanonical,
        terminalType: "conversation-attachment-store.result",
        request: {
          type: "conversation-attachment-store.perform",
          operationId: randomUUID(),
          encodedOperation: JSON.stringify({
            operation: "read",
            root: attachmentCanonical,
            rootDev: String(attachmentRootStat.dev),
            rootIno: String(attachmentRootStat.ino),
            rootUid: uid,
            id: randomUUID(),
            stallBeforeRecordRevalidateMs: 0,
          }),
        },
      },
      {
        workerPath: resolve("out/main/attachment-import-worker.js"),
        cwd: importCanonical,
        terminalType: "attachment-import.result",
        request: {
          type: "attachment-import.validate",
          operationId: randomUUID(),
          operation: {
            root: importCanonical,
            rootDev: String(importRootStat.dev),
            rootIno: String(importRootStat.ino),
            rootUid: uid,
            fileName: stagedName,
            name: "transport-probe.png",
            mimeType: "image/png",
            size: Number(stagedStat.size),
            stallBeforeValidationMs: 0,
          },
        },
      },
      {
        workerPath: resolve("out/main/secure-file-worker.js"),
        cwd: secureCanonical,
        terminalType: "secure-file.result",
        request: {
          type: "secure-file.perform",
          operationId: randomUUID(),
          request: {
            operation: "read",
            root: secureCanonical,
            rootIdentity: identity(secureRootStat),
            parentIdentities: [],
            targetIdentity: identity(secureStat),
            path: secureName,
            maxBytes: 1024,
          },
        },
      },
    ];

    const results = await app.electronApp.evaluate(
      async ({ utilityProcess }, workerProbes) => {
        const timeout = async <T>(pending: Promise<T>, label: string): Promise<T> => {
          return await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error(`${label} timed out.`)), 5_000);
            }),
          ]);
        };
        const delay = async (milliseconds: number): Promise<void> => {
          await new Promise<void>((resolveDelay) => {
            setTimeout(resolveDelay, milliseconds);
          });
        };
        const exercise = async (
          probe: WorkerProbe,
          acknowledgement: "exact" | "mismatched" | "missing",
        ): Promise<Record<string, unknown>> => {
          const child = utilityProcess.fork(probe.workerPath, [], {
            cwd: probe.cwd,
            env: {},
            stdio: "ignore",
            serviceName: "Inertia utility result acknowledgement test",
          });
          let exitObserved = false;
          const exit = new Promise<{ code: number | null }>((resolveExit) => {
            child.once("exit", (code) => {
              exitObserved = true;
              resolveExit({ code });
            });
          });
          const terminal = new Promise<Record<string, unknown>>((resolveEvent) => {
            child.on("message", (value) => {
              if (
                typeof value === "object"
                && value !== null
                && (value as Record<string, unknown>).type === probe.terminalType
              ) resolveEvent(value as Record<string, unknown>);
            });
          });
          await timeout(new Promise<void>((resolveSpawn, rejectSpawn) => {
            child.once("spawn", resolveSpawn);
            child.once("error", rejectSpawn);
          }), "worker spawn");
          child.postMessage(probe.request);
          const event = await timeout(terminal, "terminal result");
          await delay(75);
          const exitedBeforeAcknowledgement = exitObserved;
          if (acknowledgement === "missing") {
            await delay(75);
            const stayedAliveWithoutAcknowledgement = !exitObserved;
            const killAccepted = child.kill();
            const outcome = await timeout(exit, "worker kill");
            return {
              acknowledgement,
              eventOperationId: event.operationId,
              exitedBeforeAcknowledgement,
              stayedAliveWithoutAcknowledgement,
              killAccepted,
              exitCode: outcome.code,
            };
          }
          child.postMessage({
            type: probe.request.type === "conversation-attachment-store.perform"
              ? "conversation-attachment-store.result-ack"
              : probe.request.type === "attachment-import.validate"
                ? "attachment-import.result-ack"
                : "secure-file.result-ack",
            operationId: acknowledgement === "exact"
              ? probe.request.operationId
              : "00000000-0000-4000-8000-000000000000",
          });
          const outcome = await timeout(exit, "acknowledged worker exit");
          return {
            acknowledgement,
            eventOperationId: event.operationId,
            exitedBeforeAcknowledgement,
            exitCode: outcome.code,
          };
        };

        const outcomes: Record<string, unknown>[] = [];
        for (const probe of workerProbes) {
          for (const acknowledgement of ["exact", "mismatched", "missing"] as const) {
            outcomes.push(await exercise({
              ...probe,
              request: {
                ...probe.request,
                operationId: crypto.randomUUID(),
              },
            }, acknowledgement));
          }
        }
        return outcomes;
      },
      probes,
    );

    expect(results).toHaveLength(9);
    for (const result of results) {
      expect(result.eventOperationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(result.exitedBeforeAcknowledgement).toBe(false);
      if (result.acknowledgement === "exact") {
        expect(result.exitCode).toBe(0);
      } else if (result.acknowledgement === "mismatched") {
        expect(result.exitCode).toBe(1);
      } else {
        expect(result.stayedAliveWithoutAcknowledgement).toBe(true);
        expect(result.killAccepted).toBe(true);
      }
    }
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});
