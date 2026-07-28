import { useCallback, useEffect, useRef, useState } from "react";

import type {
  Conversation,
  Project,
  ServerEvent,
  WorkspaceEntry,
} from "@shared/contracts";
import {
  resultEvent,
  type CommandWithoutId,
} from "../../lib/runtimeCommands";

interface WorkspaceMentionsOptions {
  project: Project | null;
  conversation: Conversation | null;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
}

/**
 * Keeps mention results scoped to one conversation pane. Split composers may
 * query the same project concurrently without borrowing another worktree's
 * result set.
 */
export function useWorkspaceMentions({
  project,
  conversation,
  request,
}: WorkspaceMentionsOptions) {
  const [mentionResults, setMentionResults] = useState<WorkspaceEntry[]>([]);
  const requestGenerationRef = useRef(0);

  useEffect(() => {
    requestGenerationRef.current += 1;
    setMentionResults([]);
  }, [conversation?.id, project?.id]);

  const searchMentions = useCallback((query: string) => {
    const normalizedQuery = query.trim();
    const generation = ++requestGenerationRef.current;
    if (!project || !conversation || !normalizedQuery) {
      setMentionResults([]);
      return;
    }
    void request({
      type: "workspace.entries",
      payload: {
        projectId: project.id,
        conversationId: conversation.id,
        query: normalizedQuery,
      },
    }).then(resultEvent).then((event) => {
      if (
        generation === requestGenerationRef.current
        && event.result.kind === "workspace.entries"
      ) {
        setMentionResults(event.result.entries.slice(0, 8));
      }
    }).catch(() => {
      if (generation === requestGenerationRef.current) setMentionResults([]);
    });
  }, [conversation, project, request]);

  return { mentionResults, searchMentions };
}
