import type { AnyMessage, JsonRpcId, Stream } from "@agentclientprotocol/sdk";

const PROMPT_METHOD = "session/prompt";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export class AcpPromptFrames {
  private readonly frames = new WeakSet<object>();
  private promptId: JsonRpcId | undefined;

  wrap(stream: Stream): Stream {
    const writer = stream.writable.getWriter();
    return {
      writable: new WritableStream<AnyMessage>({
        write: (message) => {
          const outbound = record(message);
          if (outbound?.method === PROMPT_METHOD && "id" in outbound) {
            this.promptId = outbound.id as JsonRpcId;
          }
          return writer.write(message);
        },
        close: () => writer.close(),
        abort: (reason) => writer.abort(reason),
      }),
      readable: stream.readable.pipeThrough(new TransformStream<AnyMessage, AnyMessage>({
        transform: (message, controller) => {
          this.receive(message);
          controller.enqueue(message);
        },
      })),
    };
  }

  owns(params: unknown): boolean {
    const value = record(params);
    return value !== null && this.frames.has(value);
  }

  private receive(message: unknown): void {
    const inbound = record(message);
    if (!inbound || this.promptId === undefined) return;
    if (!("method" in inbound)) {
      if (inbound.id === this.promptId) this.promptId = undefined;
      return;
    }
    const params = record(inbound.params);
    if (!("id" in inbound) && params) this.frames.add(params);
  }
}
