export interface TranscriptPosition {
  rowId: string | null;
  viewportOffset: number;
  scrollTop: number;
  wasFollowing: boolean;
}

// Window-local navigation memory, with no transcript text or durable profile
// writes. Survives pane remounts; never grows with an unbounded chat history.
const positions = new Map<string, TranscriptPosition>();
const MAX_POSITIONS = 100;

export function readTranscriptPosition(conversationId: string | null): TranscriptPosition | undefined {
  return conversationId ? positions.get(conversationId) : undefined;
}

export function rememberTranscriptPosition(conversationId: string, position: TranscriptPosition): void {
  positions.delete(conversationId);
  positions.set(conversationId, position);
  if (positions.size > MAX_POSITIONS) positions.delete(positions.keys().next().value!);
}

export function forgetTranscriptPosition(conversationId: string): void {
  positions.delete(conversationId);
}
