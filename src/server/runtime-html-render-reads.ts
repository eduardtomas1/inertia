import type {
  RuntimeHtmlRenderDocument,
  RuntimeHtmlRenderEvent,
  RuntimeHtmlRenderReadCommand,
} from "../node/runtime-html-render-protocol.js";

export interface RuntimeHtmlRenderReader {
  readHtmlRender(renderId: string): RuntimeHtmlRenderDocument | null;
}

/** Answers main's read of one stored visual reply; the page itself never leaves the runtime otherwise. */
export function answerRuntimeHtmlRenderRead(
  runtime: RuntimeHtmlRenderReader | null,
  command: RuntimeHtmlRenderReadCommand,
): RuntimeHtmlRenderEvent {
  if (!runtime) {
    return { type: "runtime.html-render-rejected", requestId: command.requestId, message: "The local runtime is not ready." };
  }
  try {
    return { type: "runtime.html-render-resolved", requestId: command.requestId, render: runtime.readHtmlRender(command.renderId) };
  } catch {
    return { type: "runtime.html-render-rejected", requestId: command.requestId, message: "The rendered page could not be read." };
  }
}
