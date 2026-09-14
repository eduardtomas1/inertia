import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

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
  enabled: boolean;
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
  enabled,
  project,
  conversation,
  request,
}: WorkspaceMentionsOptions) {
  const [mentionResults, setMentionResults] = useState<WorkspaceEntry[]>([]);
  const requestGenerationRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectId = project?.id;
  const projectPath = project?.path;
  const conversationId = conversation?.id;
  const worktreePath = conversation?.worktreePath;
  const scope = useMemo(() => ({ projectId, projectPath, conversationId, worktreePath }),
    [projectId, projectPath, conversationId, worktreePath]);
  const invalidate = useCallback(() => {
    requestGenerationRef.current += 1;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  useLayoutEffect(() => {
    invalidate();
    setMentionResults([]);
    return invalidate;
  }, [scope, enabled, request, invalidate]);

  const searchMentions = useCallback((query: string) => {
    const normalizedQuery = query.trim();
    invalidate();
    const generation = requestGenerationRef.current;
    if (!enabled || !scope.projectId || !normalizedQuery) {
      setMentionResults([]);
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void request({
        type: "workspace.entries",
        payload: {
          projectId: scope.projectId!,
          conversationId: scope.conversationId,
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
    }, 200);
  }, [scope, enabled, request, invalidate]);

  return { mentionResults, searchMentions };
}
