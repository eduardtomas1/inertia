import { PassThrough, Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CdpPipeClient,
  CdpPipeError,
  cdpFailureCode,
  type CdpEvent,
} from "../../src/server/runtime/app-under-test/cdp-pipe-client";

interface Harness {
  client: CdpPipeClient;
  input: PassThrough;
  output: PassThrough;
  requests(): Array<Record<string, unknown>>;
  reply(frame: Record<string, unknown>): void;
}

const clients: CdpPipeClient[] = [];
const requests: Array<Promise<unknown>> = [];

/** Records every request so the suite observes each one, including those close() rejects. */
function observed(client: CdpPipeClient): CdpPipeClient {
  const send = client.send.bind(client);
  client.send = (...args) => {
    const request = send(...args);
    requests.push(request);
    return request;
  };
  clients.push(client);
  return client;
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.allSettled(requests.splice(0));
});

function harness(options: ConstructorParameters<typeof CdpPipeClient>[2] = {}): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  input.on("data", (chunk: Buffer) => { written += chunk.toString("utf8"); });
  const client = observed(new CdpPipeClient(input, output, options));
  return {
    client,
    input,
    output,
    requests: () => written.split("\0").filter(Boolean).map((frame) => JSON.parse(frame) as Record<string, unknown>),
    reply: (frame) => { output.write(`${JSON.stringify(frame)}\0`); },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("App under test CDP pipe client", () => {
  it("writes NUL-terminated requests with increasing ids and flattened session ids", async () => {
    const test = harness();
    const first = test.client.send("Target.getTargets");
    const second = test.client.send("Runtime.evaluate", { expression: "1" }, { sessionId: "S1" });
    await settle();
    expect(test.requests()).toEqual([
      { id: 1, method: "Target.getTargets", params: {} },
      { id: 2, method: "Runtime.evaluate", params: { expression: "1" }, sessionId: "S1" },
    ]);
    // Replies arrive out of order, split across chunks and joined with events.
    const event = `${JSON.stringify({ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "S1" })}\0`;
    const reply2 = `${JSON.stringify({ id: 2, result: { result: { value: "ok" } }, sessionId: "S1" })}\0`;
    const reply1 = `${JSON.stringify({ id: 1, result: { targetInfos: [] } })}\0`;
    const events: CdpEvent[] = [];
    test.client.onEvent((value) => events.push(value));
    const stream = Buffer.from(event + reply2 + reply1, "utf8");
    test.output.write(stream.subarray(0, 7));
    test.output.write(stream.subarray(7, event.length + 3));
    test.output.write(stream.subarray(event.length + 3));
    await expect(second).resolves.toEqual({ result: { value: "ok" } });
    await expect(first).resolves.toEqual({ targetInfos: [] });
    expect(events).toEqual([{ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "S1" }]);
  });

  it("decodes multi-byte UTF-8 split across chunks", async () => {
    const test = harness();
    const pending = test.client.send("Runtime.evaluate");
    await settle();
    const bytes = Buffer.from(`${JSON.stringify({ id: 1, result: { value: "Grüße 🌍" } })}\0`, "utf8");
    const split = bytes.indexOf(0xf0) + 2;
    test.output.write(bytes.subarray(0, split));
    test.output.write(bytes.subarray(split));
    await expect(pending).resolves.toEqual({ value: "Grüße 🌍" });
  });

  it("maps protocol error replies to typed remote errors and ignores unknown ids", async () => {
    const test = harness();
    const pending = test.client.send("Page.navigate");
    await settle();
    test.reply({ id: 999, result: {} });
    test.reply({ id: 1, error: { code: -32000, message: "x".repeat(1_000) } });
    const error = await pending.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(CdpPipeError);
    expect((error as CdpPipeError).code).toBe("remote");
    expect((error as CdpPipeError).message.length).toBeLessThanOrEqual(200);
    expect(test.client.closed).toBe(false);
  });

  it("closes with a typed too-large error for an unterminated frame over the bound, keeping fd 3 open", async () => {
    const test = harness({ maxFrameBytes: 1_024 });
    const pending = test.client.send("Runtime.evaluate");
    const closed = vi.fn();
    test.client.onClose(closed);
    await settle();
    test.output.write(Buffer.alloc(600, 0x61));
    test.output.write(Buffer.alloc(600, 0x61));
    await expect(pending).rejects.toMatchObject({ code: "too-large" });
    expect(test.client.closed).toBe(true);
    expect(closed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "too-large" }));
    // A bad frame stops the client, never the app: fd 3 is not ended.
    expect(test.input.destroyed).toBe(false);
    await expect(test.client.send("Target.getTargets")).rejects.toMatchObject({ code: "too-large" });
    // fd 4 keeps draining so the app can never block on a full pipe.
    expect(test.output.readableFlowing).toBe(true);
  });

  it("rejects a complete frame over the bound and a request it would not send", async () => {
    const test = harness({ maxFrameBytes: 256 });
    await expect(test.client.send("Runtime.evaluate", { expression: "x".repeat(400) }))
      .rejects.toMatchObject({ code: "too-large" });
    expect(test.client.closed).toBe(false);
    test.output.write(`${JSON.stringify({ method: "Log.entryAdded", params: { text: "y".repeat(400) } })}\0`);
    await settle();
    expect(test.client.closed).toBe(true);
  });

  it("closes on a malformed frame", async () => {
    const test = harness();
    const pending = test.client.send("Target.getTargets");
    await settle();
    test.output.write("{not json\0");
    await expect(pending).rejects.toMatchObject({ code: "protocol" });
    expect(test.input.destroyed).toBe(false);
  });

  it("applies the per-request deadline and ignores a late reply", async () => {
    const test = harness();
    const pending = test.client.send("Runtime.evaluate", {}, { timeoutMs: 20 });
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
    expect(test.client.pendingRequests).toBe(0);
    test.reply({ id: 1, result: {} });
    await settle();
    expect(test.client.closed).toBe(false);
  });

  it("cancels with the caller's signal", async () => {
    const test = harness();
    const controller = new AbortController();
    const pending = test.client.send("Runtime.evaluate", {}, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await expect(test.client.send("Runtime.evaluate", {}, { signal: controller.signal }))
      .rejects.toMatchObject({ code: "cancelled" });
  });

  it("bounds pending requests", async () => {
    const test = harness({ maxPending: 2 });
    const first = test.client.send("A");
    const second = test.client.send("B");
    await expect(test.client.send("C")).rejects.toMatchObject({ code: "overloaded" });
    test.client.close();
    await expect(first).rejects.toMatchObject({ code: "closed" });
    await expect(second).rejects.toMatchObject({ code: "closed" });
  });

  it("releases fd 3 only on close(), once, and fails every pending request", async () => {
    const test = harness();
    const pending = test.client.send("Target.getTargets");
    const closed = vi.fn();
    test.client.onClose(closed);
    test.client.close();
    test.client.close();
    await expect(pending).rejects.toMatchObject({ code: "closed" });
    expect(test.input.destroyed).toBe(true);
    expect(closed).toHaveBeenCalledOnce();
    await expect(test.client.send("Target.getTargets")).rejects.toMatchObject({ code: "closed" });
    const late = vi.fn();
    test.client.onClose(late);
    await settle();
    expect(late).toHaveBeenCalledOnce();
  });

  it("never leaves an unhandled rejection for a request nobody awaits when the client closes", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      // A caller that stopped waiting (it lost a race or hit its own deadline)
      // no longer observes its request; close() still rejects it.
      const client = new CdpPipeClient(new PassThrough(), new PassThrough());
      void client.send("Target.getTargets");
      const awaited = client.send("Runtime.evaluate");
      client.close();
      await expect(awaited).rejects.toMatchObject({ code: "closed" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("closes when the app ends fd 4, without ending fd 3 itself", async () => {
    const test = harness();
    const pending = test.client.send("Target.getTargets");
    test.output.end();
    await expect(pending).rejects.toMatchObject({ code: "closed" });
    expect(test.client.closed).toBe(true);
    expect(test.input.destroyed).toBe(false);
  });

  it("queues writes behind backpressure and flushes them in order after drain", async () => {
    const chunks: string[] = [];
    let release: (() => void) | null = null;
    const input = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString("utf8"));
        release = callback;
      },
    });
    const output = new PassThrough();
    const client = observed(new CdpPipeClient(input, output));
    const writes = vi.spyOn(input, "write");
    const sent = [client.send("A"), client.send("B"), client.send("C")];
    // The first write fills the buffer; the others wait for drain.
    expect(writes).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 3; index += 1) {
      await settle();
      const callback = release as (() => void) | null;
      release = null;
      callback?.();
    }
    await settle();
    expect(chunks.map((chunk) => (JSON.parse(chunk.slice(0, -1)) as { method: string }).method)).toEqual(["A", "B", "C"]);
    for (const [index] of sent.entries()) output.write(`${JSON.stringify({ id: index + 1, result: {} })}\0`);
    await expect(Promise.all(sent)).resolves.toHaveLength(3);
  });

  it("never sends a request held back by backpressure after it timed out or was cancelled", async () => {
    const chunks: string[] = [];
    let release: (() => void) | null = null;
    const input = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString("utf8"));
        release = callback;
      },
    });
    const output = new PassThrough();
    const client = observed(new CdpPipeClient(input, output));
    const first = client.send("A");
    const late = client.send("Input.insertText", { text: "late" }, { timeoutMs: 5 });
    const controller = new AbortController();
    const cancelled = expect(client.send("Input.dispatchKeyEvent", {}, { signal: controller.signal }))
      .rejects.toMatchObject({ code: "cancelled" });
    controller.abort();
    await cancelled;
    await expect(late).rejects.toMatchObject({ code: "timeout" });
    expect(client.pendingRequests).toBe(1);
    const next = client.send("B");
    for (let index = 0; index < 3; index += 1) {
      await settle();
      const callback = release as (() => void) | null;
      release = null;
      callback?.();
    }
    await settle();
    expect(chunks.map((chunk) => (JSON.parse(chunk.slice(0, -1)) as { method: string }).method)).toEqual(["A", "B"]);
    output.write(`${JSON.stringify({ id: 1, result: {} })}\0${JSON.stringify({ id: 4, result: {} })}\0`);
    await expect(Promise.all([first, next])).resolves.toHaveLength(2);
  });

  it("maps pipe errors to App failure codes", () => {
    expect(cdpFailureCode("timeout")).toBe("timeout");
    expect(cdpFailureCode("too-large")).toBe("too-large");
    expect(cdpFailureCode("cancelled")).toBe("cancelled");
    for (const code of ["closed", "protocol", "remote", "overloaded"] as const) {
      expect(cdpFailureCode(code)).toBe("unavailable");
    }
  });
});
