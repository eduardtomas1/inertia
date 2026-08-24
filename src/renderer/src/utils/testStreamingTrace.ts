const STREAMING_READER_ACTIVITY_SUFFIX_MAX_CHARS = 96;
const STREAMING_READER_ACTIVITY_SUFFIX =
  /(?:^|[\t\n\r ])(STREAM_PROVIDER_READER_ACTIVITY_[1-9]\d{0,3}_(?:BEFORE|AWAY))[\t\n\r ]*$/u;

export function streamingReaderActivityReceiptStage(marker: string): string {
  return `renderer-reader-activity-committed:${marker}`;
}

export function markTestStreamingReaderActivityReceipt(
  streamingText: string,
): void {
  const trace = Reflect.get(globalThis, "__inertiaTestStreamingTrace");
  // Stay inert in production and return before slicing provider text. Benchmark
  // instrumentation inspects only the bounded tail and publishes only the marker.
  if (typeof trace !== "function") return;

  const suffix = streamingText.slice(-STREAMING_READER_ACTIVITY_SUFFIX_MAX_CHARS);
  const marker = STREAMING_READER_ACTIVITY_SUFFIX.exec(suffix)?.[1];
  if (marker) trace(streamingReaderActivityReceiptStage(marker));
}

export function markTestStreamingStage(stage: string): void {
  const trace = Reflect.get(globalThis, "__inertiaTestStreamingTrace");
  if (typeof trace === "function") trace(stage);
}
