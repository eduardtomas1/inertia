// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { UtilityProcess } from "electron";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

interface DecoderObservation {
  pid?: number;
  exit?: number;
  messages: number;
  envKeys: string[];
  execArgv: string[];
  inputKeys?: string[];
  payloadKeys?: string[];
}

async function observeDecoder(fixture: AppFixture, mode: "stall" | "exit-first"): Promise<void> {
  await fixture.electronApp.evaluate(({ utilityProcess }, behavior) => {
    const observations: DecoderObservation[] = [];
    const results: Array<{ ok: boolean; shutdownConfirmed: boolean; message?: string }> = [];
    let runtime: UtilityProcess;
    Reflect.set(globalThis, "documentDecoderProbe", {
      observations, results,
      request: (bytes: number[]) => {
        // File-backed sends no longer decode PDFs. Exercise the existing main
        // broker using the real runtime's event boundary and native utilities.
        runtime.emit("message", {
          type: "runtime.document-preparation-request", requestId: crypto.randomUUID(),
          operation: { deadlineAt: Date.now() + 43_000, payloads: [{
            id: "pdf-probe", name: "notes.pdf", mimeType: "application/pdf", bytes: Uint8Array.from(bytes),
          }] },
        });
      },
    });
    const original = utilityProcess.fork;
    utilityProcess.fork = (modulePath, args, options) => {
      const child = original(modulePath, args, options);
      const post = child.postMessage.bind(child);
      if (options?.serviceName === "Inertia Runtime") {
        runtime = child;
        child.postMessage = (message, transfer) => {
          if (message?.type === "runtime.document-preparation-result") { results.push(message); return; }
          post(message, transfer);
        };
      }
      if (options?.serviceName !== "Inertia Document Decoder") return child;
      const observation: DecoderObservation = { messages: 0, envKeys: Object.keys(options.env ?? {}), execArgv: options.execArgv ?? [] };
      observations.push(observation);
      const first = observations.length === 1;
      child.postMessage = (message, transfer) => {
        if (message?.type === "document.prepare") {
          observation.inputKeys = Object.keys(message.operation).sort();
          observation.payloadKeys = Object.keys(message.operation.payloads[0]).sort();
          if (behavior === "stall") return;
          if (first) { child.kill(); return; }
        }
        post(message, transfer);
      };
      child.once("spawn", () => { observation.pid = child.pid; });
      child.on("message", () => { observation.messages += 1; });
      child.once("exit", (code) => { observation.exit = code; });
      return child;
    };
  }, mode);
  await fixture.recycleRuntime();
}

async function requestDecode(fixture: AppFixture): Promise<void> {
  const bytes = [...await readFile(fixture.attachmentDocumentPath)];
  await fixture.electronApp.evaluate((_, input) => {
    Reflect.get(globalThis, "documentDecoderProbe").request(input);
  }, bytes);
}

async function observations(fixture: AppFixture): Promise<DecoderObservation[]> {
  return await fixture.electronApp.evaluate(() => Reflect.get(globalThis, "documentDecoderProbe").observations);
}

test("terminates an admitted decoder before completing runtime recycle", async ({ browserName: _browserName }, testInfo) => {
  const fixture = await createAppFixture({ name: "document-decoder-recycle", initialState: "conversation" });
  try {
    await observeDecoder(fixture, "stall");
    const before = await fixture.runtimeSnapshot();
    await requestDecode(fixture);
    await expect.poll(async () => (await observations(fixture))[0]?.inputKeys).toEqual(["deadlineAt", "payloads"]);
    await fixture.recycleRuntime();
    const [observation] = await observations(fixture);
    expect(observation!.pid).toBeGreaterThan(0);
    expect(typeof observation!.exit).toBe("number");
    expect((await fixture.runtimeSnapshot()).generation).toBeGreaterThan(before.generation);
    await testInfo.attach("Decoder exit before recycle", { body: JSON.stringify(observation), contentType: "application/json" });
  } finally { await fixture.close(); }
});

test("survives an early decoder exit, retries decoding, and sends a PDF without decoding it", async ({ browserName: _browserName }, testInfo) => {
  const fixture = await createAppFixture({ name: "document-decoder-isolation", initialState: "conversation" });
  try {
    await observeDecoder(fixture, "exit-first");
    const { page, electronApp } = fixture;
    const before = await fixture.runtimeSnapshot();
    await requestDecode(fixture);
    await expect.poll(() => electronApp.evaluate(() => Reflect.get(globalThis, "documentDecoderProbe").results[0])).toMatchObject({
      ok: false, shutdownConfirmed: true, message: "The document decoder stopped unexpectedly.",
    });
    expect((await fixture.runtimeSnapshot()).pid).toBe(before.pid);
    await requestDecode(fixture);
    await expect.poll(() => electronApp.evaluate(() => Reflect.get(globalThis, "documentDecoderProbe").results[1])).toMatchObject({
      ok: true, shutdownConfirmed: true,
    });
    const decoded = await observations(fixture);
    expect(decoded).toHaveLength(2);
    // macOS kill() may report code zero; a missing result still rejects the request.
    expect(typeof decoded[0]!.exit).toBe("number");
    expect(decoded[0]!.messages).toBe(0);
    expect(decoded[1]!.messages).toBe(1);
    expect(decoded[1]!.exit).toBe(0);
    for (const observation of decoded) {
      expect(observation.pid).toBeGreaterThan(0);
      expect(observation.pid).not.toBe(before.pid);
      expect(observation.envKeys).toEqual([]);
      expect(observation.execArgv).toEqual(["--max-old-space-size=256"]);
      expect(observation.inputKeys).toEqual(["deadlineAt", "payloads"]);
      expect(observation.payloadKeys).toEqual(["bytes", "id", "mimeType", "name"]);
    }
    await electronApp.evaluate(({ dialog }, path) => {
      Reflect.set(dialog, "showOpenDialog", async () => ({ canceled: false, filePaths: [path], bookmarks: [] }));
    }, fixture.attachmentDocumentPath);
    await page.getByRole("button", { name: "Attach images, documents, or spreadsheets" }).click();
    const draft = page.getByRole("list", { name: "Attachments", exact: true });
    await expect(draft.getByText("notes.pdf", { exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "Message" }).fill("Read this PDF with your file tools.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(draft).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Message attachments", exact: true })
      .getByText("notes.pdf", { exact: true })).toBeVisible();
    expect(await observations(fixture)).toHaveLength(2);
    expect((await fixture.runtimeSnapshot()).generation).toBe(before.generation);
    await testInfo.attach("Native decoder isolation", { body: JSON.stringify({ runtimePid: before.pid, observations: decoded }, null, 2), contentType: "application/json" });
    expect(fixture.rendererErrors).toEqual([]);
  } finally { await fixture.close(); }
});
