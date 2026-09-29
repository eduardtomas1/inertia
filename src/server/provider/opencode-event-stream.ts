const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

export const OPENCODE_OVERSIZED_EVENT_MESSAGE = "OpenCode sent an oversized event.";

export function boundedOpenCodeEventFetch(
  maxFrameBytes: number,
  onOverflow: () => void,
): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (!response.body) return response;
    let frameBytes = 0;
    let lineBreaks = 0;
    let afterCarriageReturn = false;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        for (const byte of chunk) {
          if (byte === LINE_FEED && afterCarriageReturn) {
            afterCarriageReturn = false;
            continue;
          }
          afterCarriageReturn = byte === CARRIAGE_RETURN;
          if (byte === LINE_FEED || byte === CARRIAGE_RETURN) {
            lineBreaks += 1;
            if (lineBreaks >= 2) {
              frameBytes = 0;
              continue;
            }
          } else {
            lineBreaks = 0;
          }
          frameBytes += 1;
          if (frameBytes > maxFrameBytes) {
            onOverflow();
            controller.error(new Error(OPENCODE_OVERSIZED_EVENT_MESSAGE));
            return;
          }
        }
        controller.enqueue(chunk);
      },
    }));
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
