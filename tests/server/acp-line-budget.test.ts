// @inertia-test-suite portable
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { BoundedJsonLineTransform } from "../../src/server/provider/cursor-acp-framing";
import { BoundedGeminiJsonLineTransform } from "../../src/server/provider/gemini-acp-support";
import { BoundedKimiJsonLineTransform } from "../../src/server/provider/kimi-acp-support";
import { ProviderRunEventBudget } from "../../src/server/provider/io";

const implementations = [
  ["Cursor", BoundedJsonLineTransform],
  ["Gemini", BoundedGeminiJsonLineTransform],
  ["Kimi", BoundedKimiJsonLineTransform],
] as const;

describe.each(implementations)("%s ACP line accounting", (label, Transform) => {
  async function decode(chunks: Buffer[], maxEvents = 20): Promise<string> {
    let output = "";
    await pipeline(Readable.from(chunks), new Transform(
      1024, new ProviderRunEventBudget(label, 1024, maxEvents, 4096, { now: () => 0 }),
    ), new Writable({ write(chunk: Buffer, _encoding, callback) {
      output += chunk.toString("utf8"); callback();
    } }));
    return output;
  }
  it("accepts split CRLF blank lines and preserves a valid Unicode frame", async () => {
    const frame = '{"jsonrpc":"2.0","id":1,"result":"日本"}';
    await expect(decode([Buffer.from("\r"), Buffer.from("\n \t\r\n" + frame + "\r\n")]))
      .resolves.toBe(frame + "\r\n");
  });
  it("charges blank lines against the event budget", async () => {
    await expect(decode([Buffer.from("\n\n\n")], 2)).rejects.toThrow(/exceeded the bounded event rate/);
  });
  it("refuses an exhausted budget before parsing the next frame", async () => {
    await expect(decode([Buffer.from("\n{malformed}\n")], 1)).rejects.toThrow(/exceeded the bounded event rate/);
  });
  it("still rejects invalid UTF-8 and malformed envelopes", async () => {
    await expect(decode([Buffer.from([0xff, 0x0a])])).rejects.toThrow();
    await expect(decode([Buffer.from('{"unexpected":true}\n')])).rejects.toThrow(/malformed/);
  });
});
