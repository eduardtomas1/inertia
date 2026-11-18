import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CursorSdkChannel } from "../../src/node/cursor-sdk-channel";

function pair(handler: (method: string, params: unknown) => Promise<unknown>) {
  const input = new PassThrough(); const output = new PassThrough();
  const failA = vi.fn(); const failB = vi.fn();
  const a = new CursorSdkChannel(input, output, async () => null, failA);
  const b = new CursorSdkChannel(output, input, handler, failB);
  return { a, b, input, output, failA, failB };
}
describe("Cursor SDK private channel", () => {
  it("correlates private requests without exposing operation errors", async () => {
    const f = pair(async (_method, input) => input);
    await expect(f.a.request("echo", { text: "synthetic-test-token" })).resolves.toEqual({ text: "synthetic-test-token" });
    f.a.close(); f.b.close();
    const broken = pair(async () => { throw new Error("synthetic-test-token"); });
    await expect(broken.a.request("start", null)).rejects.toThrow(/^Cursor SDK operation failed\.$/u);
    broken.a.close(); broken.b.close();
  });
  it("fails closed on malformed and uncorrelated messages", () => {
    const f = pair(async () => null);
    f.input.write('{broken}\n'); expect(f.failA).toHaveBeenCalledOnce();
    f.b.close();
    const foreign = pair(async () => null);
    foreign.input.write(JSON.stringify({ id: randomUUID(), ok: true, result: null }) + '\n');
    expect(foreign.failA).toHaveBeenCalledOnce(); foreign.b.close();
  });
  it("bounds input frames and pending requests", async () => {
    const f = pair(async () => await new Promise(() => undefined));
    const pending = Array.from({ length: 8 }, () => f.a.request("start", null).catch(() => null));
    await expect(f.a.request("start", null)).rejects.toThrow("unavailable");
    f.input.write(Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    expect(f.failA).toHaveBeenCalledOnce(); await Promise.all(pending); f.b.close();
  });
  it("times out without leaving pending work or unhandled rejection", async () => {
    vi.useFakeTimers();
    const f = pair(async () => await new Promise(() => undefined));
    const pending = expect(f.a.request("start", null, 20)).rejects.toThrow("closed");
    await vi.advanceTimersByTimeAsync(21); await pending;
    expect(f.failA).toHaveBeenCalledOnce(); f.b.close(); vi.useRealTimers();
  });
  it("rejects reused request IDs", async () => {
    const f = pair(async () => null); const frame = JSON.stringify({ id: randomUUID(), method: "hello", params: null }) + '\n';
    f.input.write(frame); f.input.write(frame);
    expect(f.failA).toHaveBeenCalledOnce(); f.b.close();
  });
});
