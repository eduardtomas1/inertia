import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createAppFixture } from "./support/app-fixture";

test("the real update validator decodes Electron message envelopes and acknowledges its result", async () => {
  const fixture = await createAppFixture({ name: "update-viability-transport", initialState: "empty" });
  try {
    const data = join(fixture.testDirectory, "candidate-data");
    await mkdir(data, { mode: 0o700 });
    const request = { schemaVersion: 1, operationId: randomUUID(),
      dataDirectory: await realpath(data), expectedActiveRuntimeOwner: null };
    for (const exact of [true, false]) {
      const result = await fixture.electronApp.evaluate(async ({ utilityProcess }, input) => {
        const child = utilityProcess.fork(input.worker, [], { env: {}, stdio: "ignore" });
        return await new Promise<{ event: unknown; code: number; acknowledged: boolean }>((resolveProbe, reject) => {
          let event: unknown;
          let acknowledged = false;
          const timeout = setTimeout(() => { child.kill(); reject(new Error("Update validator transport timed out.")); }, 5_000);
          child.once("error", (error) => { clearTimeout(timeout); child.kill(); reject(error); });
          child.once("spawn", () => child.postMessage(input.request));
          child.once("message", (value) => {
            event = value;
            acknowledged = true;
            child.postMessage({ schemaVersion: 1, type: "result-ack",
              operationId: input.exact ? input.request.operationId : "00000000-0000-4000-8000-000000000000" });
          });
          child.once("exit", (code) => {
            clearTimeout(timeout);
            resolveProbe({ event, code, acknowledged });
          });
        });
      }, { worker: resolve("out/main/app-update-candidate-viability-worker.js"), request, exact });
      expect(result.event).toEqual({ schemaVersion: 1, operationId: request.operationId,
        status: "validated", code: null });
      expect(result.acknowledged).toBe(true);
      expect(result.code).toBe(exact ? 0 : 1);
    }
  } finally { await fixture.close(); }
});
