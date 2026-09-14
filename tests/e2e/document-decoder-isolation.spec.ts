// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { createAppFixture } from "./support/app-fixture";

test("terminates an admitted decoder before completing runtime recycle", async ({ browserName: _browserName }, testInfo) => {
  const fixture = await createAppFixture({ name: "document-decoder-recycle", initialState: "conversation" });
  try {
    const { page, electronApp } = fixture;
    const before = await fixture.runtimeSnapshot();
    await electronApp.evaluate(({ utilityProcess, dialog }, path) => {
      Reflect.set(dialog, "showOpenDialog", async () => ({ canceled: false, filePaths: [path], bookmarks: [] }));
      const observation: { pid?: number; admitted: boolean; exit?: number } = { admitted: false };
      Reflect.set(globalThis, "documentDecoderRecycle", observation);
      const original = utilityProcess.fork;
      utilityProcess.fork = (modulePath, args, options) => {
        const child = original(modulePath, args, options);
        if (options?.serviceName !== "Inertia Document Decoder") return child;
        const post = child.postMessage.bind(child);
        child.postMessage = (message, transfer) => {
          if (message?.type === "document.prepare") { observation.admitted = true; return; }
          post(message, transfer);
        };
        child.once("spawn", () => { observation.pid = child.pid; });
        child.once("exit", (code) => { observation.exit = code; });
        return child;
      };
    }, fixture.attachmentDocumentPath);
    await page.getByRole("button", { name: "Attach images, documents, or spreadsheets" }).click();
    await expect(page.getByRole("list", { name: "Attachments", exact: true }).getByText("notes.pdf", { exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "Message" }).fill("Recycle while this PDF decoder is waiting.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect.poll(() => electronApp.evaluate(() => Reflect.get(globalThis, "documentDecoderRecycle").admitted)).toBe(true);
    await fixture.recycleRuntime();
    const observation = await electronApp.evaluate(() => Reflect.get(globalThis, "documentDecoderRecycle")) as { pid: number; exit?: number };
    expect(observation.pid).toBeGreaterThan(0);
    expect(typeof observation.exit).toBe("number");
    expect((await fixture.runtimeSnapshot()).generation).toBeGreaterThan(before.generation);
    await testInfo.attach("Decoder exit before recycle", { body: JSON.stringify(observation), contentType: "application/json" });
  } finally { await fixture.close(); }
});

test("survives an early document decoder exit and retries the retained PDF draft", async ({ browserName: _browserName }, testInfo) => {
  const fixture = await createAppFixture({ name: "document-decoder-isolation", initialState: "conversation" });
  try {
    const { page, electronApp } = fixture;
    const before = await fixture.runtimeSnapshot();
    const instrumentation = await electronApp.evaluate(({ app, utilityProcess }) => {
      const runtimePid = app.getAppMetrics().find((entry) => entry.name === "Inertia Runtime")?.pid;
      const observations: Array<{ pid?: number; exit?: number; messages: number; envKeys: string[]; execArgv: string[]; inputKeys?: string[]; payloadKeys?: string[] }> = [];
      const original = utilityProcess.fork;
      Reflect.set(globalThis, "documentDecoderObservations", observations);
      utilityProcess.fork = (modulePath, args, options) => {
        const child = original(modulePath, args, options);
        if (options?.serviceName !== "Inertia Document Decoder") return child;
        const observation: (typeof observations)[number] = { messages: 0, envKeys: Object.keys(options.env ?? {}), execArgv: options.execArgv ?? [] };
        observations.push(observation);
        const killThisDecoder = observations.length === 1;
        const post = child.postMessage.bind(child);
        child.postMessage = (message, transfer) => {
          if (message?.type === "document.prepare") {
            observation.inputKeys = Object.keys(message.operation).sort();
            observation.payloadKeys = Object.keys(message.operation.payloads[0]).sort();
            // Inject an actual native process exit after admission, without a
            // decompression bomb or changes to production decoder behavior.
            if (killThisDecoder) { child.kill(); return; }
          }
          post(message, transfer);
        };
        child.once("spawn", () => { observation.pid = child.pid; });
        child.on("message", () => { observation.messages += 1; });
        child.once("exit", (code) => { observation.exit = code; });
        return child;
      };
      return { runtimePid };
    });
    expect(instrumentation.runtimePid).toBeGreaterThan(0);
    await electronApp.evaluate(({ dialog }, path) => {
      Reflect.set(dialog, "showOpenDialog", async () => ({ canceled: false, filePaths: [path], bookmarks: [] }));
    }, fixture.attachmentDocumentPath);
    await page.getByRole("button", { name: "Attach images, documents, or spreadsheets" }).click();
    const draft = page.getByRole("list", { name: "Attachments", exact: true });
    await expect(draft.getByText("notes.pdf", { exact: true })).toBeVisible();
    const message = page.getByRole("textbox", { name: "Message" });
    await message.fill("Read this PDF and retain the draft if decoding fails.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("The document decoder stopped unexpectedly.", { exact: true })).toBeVisible();
    await expect(message).toHaveValue("Read this PDF and retain the draft if decoding fails.");
    await expect(draft.getByText("notes.pdf", { exact: true })).toBeVisible();
    const failed = await fixture.runtimeSnapshot();
    expect(failed.generation).toBe(before.generation);
    expect(await electronApp.evaluate(({ app }) =>
      app.getAppMetrics().find((entry) => entry.name === "Inertia Runtime")?.pid)).toBe(instrumentation.runtimePid);

    await page.getByRole("button", { name: "Send message" }).click();
    await expect(draft).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Message attachments", exact: true })
      .getByText("notes.pdf", { exact: true })).toBeVisible();
    const observations = await electronApp.evaluate(() => Reflect.get(globalThis, "documentDecoderObservations")) as
      Array<{ pid: number; exit: number; messages: number; envKeys: string[]; execArgv: string[]; inputKeys: string[]; payloadKeys: string[] }>;
    expect(observations).toHaveLength(2);
    // macOS utilityProcess.kill() can report exit code 0. Missing the result
    // must still reject the send rather than trusting the code alone.
    expect(typeof observations[0]!.exit).toBe("number");
    expect(observations[0]!.messages).toBe(0);
    expect(observations[1]!.messages).toBe(1);
    expect(observations[1]!.exit).toBe(0);
    for (const observation of observations) {
      expect(observation.pid).toBeGreaterThan(0);
      expect(observation.pid).not.toBe(instrumentation.runtimePid);
      expect(observation.envKeys).toEqual([]);
      expect(observation.execArgv).toEqual(["--max-old-space-size=256"]);
      expect(observation.inputKeys).toEqual(["deadlineAt", "payloads"]);
      expect(observation.payloadKeys).toEqual(["bytes", "id", "mimeType", "name"]);
    }
    expect((await fixture.runtimeSnapshot()).generation).toBe(before.generation);
    await testInfo.attach("Native decoder isolation", { body: JSON.stringify({ runtimePid: instrumentation.runtimePid, observations }, null, 2), contentType: "application/json" });
    expect(fixture.rendererErrors).toEqual([]);
  } finally { await fixture.close(); }
});
