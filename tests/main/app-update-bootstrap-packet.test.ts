// @inertia-test-suite portable
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { readAppUpdateBootstrapPacket } from "../../src/main/app-update-bootstrap";

describe("app update bootstrap framing", () => {
  it("accepts a split ACK before the AppImage wrapper closes its stdout", async () => {
    const output = new PassThrough();
    const acknowledgement = readAppUpdateBootstrapPacket(output, 100, "line");
    output.write('{"operationId":');
    output.write('"candidate"}');
    output.write("\n");
    await expect(acknowledgement).resolves.toEqual({ operationId: "candidate" });
    expect(output.writableEnded).toBe(false);
    expect(output.listenerCount("data")).toBe(0);
    output.destroy();
  });

  it("continues to accept an EOF-delimited predecessor packet", async () => {
    const output = new PassThrough();
    const packet = readAppUpdateBootstrapPacket(output, 100, "line");
    output.end('{"revision":1}');
    await expect(packet).resolves.toEqual({ revision: 1 });
  });

  it.each(['{"revision":\n', '{"revision":1}\n{"revision":2}\n']) (
    "rejects malformed or multiple framed packets", async (value) => {
      const output = new PassThrough();
      const packet = readAppUpdateBootstrapPacket(output, 100, "line");
      output.write(value);
      await expect(packet).rejects.toThrow("packet is invalid");
      output.destroy();
    },
  );

  it("bounds a wrapper that sends no complete ACK", async () => {
    const output = new PassThrough();
    const packet = readAppUpdateBootstrapPacket(output, 20, "line");
    output.write('{"revision":1}');
    await expect(packet).rejects.toThrow("acknowledgement timed out");
    output.destroy();
  });

  it("rejects oversized output before a delimiter arrives", async () => {
    const output = new PassThrough();
    const packet = readAppUpdateBootstrapPacket(output, 100, "line");
    output.write(" ".repeat(2_049));
    await expect(packet).rejects.toThrow("packet is oversized");
    output.destroy();
  });

  it("still waits for EOF on the secret channel", async () => {
    const input = new PassThrough();
    const packet = readAppUpdateBootstrapPacket(input, 20);
    input.write('{"secret":"value"}\n');
    await expect(packet).rejects.toThrow("acknowledgement timed out");
    input.destroy();
  });
});
