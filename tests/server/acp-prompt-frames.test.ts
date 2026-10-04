import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { AcpPromptFrames } from "../../src/server/provider/acp-prompt-frames";

function wired() {
  const written: AnyMessage[] = [];
  let push!: (message: AnyMessage) => void;
  const readable = new ReadableStream<AnyMessage>({
    start: (controller) => {
      push = (message) => controller.enqueue(message);
    },
  });
  const writable = new WritableStream<AnyMessage>({ write: (message) => { written.push(message); } });
  const frames = new AcpPromptFrames();
  const stream: Stream = frames.wrap({ readable, writable });
  return { frames, stream, push, written };
}

const notification = (text: string): AnyMessage => ({ jsonrpc: "2.0", method: "cursor/update_todos", params: { text } });

describe("ACP prompt frames", () => {
  it("owns exactly the notifications received between the prompt request and its response", async () => {
    const { frames, stream, push, written } = wired();
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();
    const before = notification("before");
    push(before);
    expect((await reader.read()).value).toBe(before);
    await writer.write({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId: "s", prompt: [] } });
    const during = notification("during");
    const request: AnyMessage = { jsonrpc: "2.0", id: "ask", method: "cursor/ask_question", params: { text: "ask" } };
    const otherResponse: AnyMessage = { jsonrpc: "2.0", id: 3, result: {} };
    const last = notification("last");
    const after = notification("after");
    for (const message of [during, request, otherResponse, last, { jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } }, after] as AnyMessage[]) {
      push(message);
    }
    for (let index = 0; index < 6; index += 1) await reader.read();
    expect(written).toHaveLength(1);
    const params = (message: AnyMessage) => (message as { params?: unknown }).params;
    expect([before, during, request, last, after].map((message) => frames.owns(params(message))))
      .toEqual([false, true, false, true, false]);
    expect(frames.owns(undefined)).toBe(false);
    expect(frames.owns({ text: "during" })).toBe(false);
  });
});
