import { parseUnifiedDiff } from "@shared/diff-review";

interface DiffParseRequest {
  id: number;
  patch: string;
}

self.addEventListener("message", (event: MessageEvent<DiffParseRequest>) => {
  const { id, patch } = event.data;
  try {
    self.postMessage({ id, result: parseUnifiedDiff(patch) });
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error
        ? error.message
        : "The diff could not be parsed.",
    });
  }
});
