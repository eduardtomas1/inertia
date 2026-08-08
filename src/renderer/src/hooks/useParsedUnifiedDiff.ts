import { useEffect, useMemo, useState } from "react";
import type { StructuredDiff } from "@shared/contracts";
import { parseUnifiedDiff } from "@shared/diff-review";
import { parseDiffOffMainThread } from "../utils/diffParserPool";

export const DIFF_WORKER_THRESHOLD_CHARS = 256 * 1024;
const EMPTY_DIFF = parseUnifiedDiff("");

export function useParsedUnifiedDiff(patch: string): {
  structured: StructuredDiff;
  parsing: boolean;
  error: string | null;
} {
  const parseSynchronously = patch.length <= DIFF_WORKER_THRESHOLD_CHARS
    || typeof Worker === "undefined";
  const synchronous = useMemo(
    () => parseSynchronously ? parseUnifiedDiff(patch) : null,
    [parseSynchronously, patch],
  );
  const [completed, setCompleted] = useState<{
    patch: string;
    structured: StructuredDiff;
  } | null>(null);
  const [failed, setFailed] = useState<{
    patch: string;
    message: string;
  } | null>(null);

  useEffect(() => {
    if (parseSynchronously) return;
    const controller = new AbortController();
    void parseDiffOffMainThread(patch, controller.signal).then((structured) => {
      if (controller.signal.aborted) return;
      setCompleted({ patch, structured });
      setFailed(null);
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setFailed({
        patch,
        message: error instanceof Error
          ? error.message
          : "The diff could not be parsed.",
      });
    });
    return () => controller.abort();
  }, [parseSynchronously, patch]);

  if (synchronous) {
    return { structured: synchronous, parsing: false, error: null };
  }
  if (completed?.patch === patch) {
    return { structured: completed.structured, parsing: false, error: null };
  }
  return {
    structured: EMPTY_DIFF,
    parsing: failed?.patch !== patch,
    error: failed?.patch === patch ? failed.message : null,
  };
}
