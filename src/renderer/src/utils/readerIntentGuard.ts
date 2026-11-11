const READER_INTENT_GUARD_MS = 750;
const UNRENDERED_FRAME_CEILING_MS = 5_000;

export function startReaderIntentGuard(release: () => void): () => void {
  let frame: number | null = null;
  let ceiling: number | null = null;
  let ended = false;
  const end = (): void => {
    if (ended) return;
    stop();
    release();
  };
  const stop = (): void => {
    ended = true;
    window.clearTimeout(timer);
    if (ceiling !== null) window.clearTimeout(ceiling);
    if (frame !== null) window.cancelAnimationFrame(frame);
  };
  const timer = window.setTimeout(() => {
    if (document.visibilityState === "hidden") {
      end();
      return;
    }
    ceiling = window.setTimeout(end, UNRENDERED_FRAME_CEILING_MS);
    frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(end);
    });
  }, READER_INTENT_GUARD_MS);
  return stop;
}
