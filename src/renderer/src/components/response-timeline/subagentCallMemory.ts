export interface SubagentCallMemoryEntry {
  expanded: boolean;
  live: boolean;
}

export interface SubagentCallMemory {
  read: (traceId: string) => SubagentCallMemoryEntry | undefined;
  write: (traceId: string, entry: SubagentCallMemoryEntry) => void;
}

const MAX_REMEMBERED_CALLS = 500;

export function createSubagentCallMemory(limit = MAX_REMEMBERED_CALLS): SubagentCallMemory {
  const entries = new Map<string, SubagentCallMemoryEntry>();
  return {
    read: (traceId) => entries.get(traceId),
    write: (traceId, entry) => {
      entries.delete(traceId);
      entries.set(traceId, entry);
      for (const oldest of entries.keys()) {
        if (entries.size <= limit) break;
        entries.delete(oldest);
      }
    },
  };
}

export const transcriptSubagentCallMemory = createSubagentCallMemory();
