import { useEffect, type ComponentType } from "react";
import { useStreamingAgentState, type StreamingAgentSource } from "../../hooks/useStreamingAgentState";
import { markTestStreamingReaderActivityReceipt } from "../../utils/testStreamingTrace";
import type { ResponseTimelineProps } from "./types";

export function StreamingResponseTimeline({
  ResponseTimeline,
  streaming,
  onStreamingContent,
  ...props
}: Omit<
  ResponseTimelineProps,
  "streamingText" | "streamingReasoning" | "streamingChannel"
> & {
  ResponseTimeline: ComponentType<ResponseTimelineProps>;
  streaming: StreamingAgentSource;
  onStreamingContent: () => (() => void) | undefined;
}): React.JSX.Element {
  const [streamingText, streamingReasoning, streamingChannel] =
    useStreamingAgentState(streaming);
  useEffect(() => {
    if (!streamingText && !streamingReasoning) return;
    markTestStreamingReaderActivityReceipt(streamingText);
    return onStreamingContent();
  }, [onStreamingContent, streamingReasoning, streamingText]);
  return (
    <ResponseTimeline
      {...props}
      streamingText={streamingText}
      streamingReasoning={streamingReasoning}
      streamingChannel={streamingChannel}
    />
  );
}
