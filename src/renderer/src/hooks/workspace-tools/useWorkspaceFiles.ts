import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Conversation,
  Project,
  ProjectAction,
  ServerEvent,
  WorkspaceEntry,
  WorkspaceFilePreview,
} from "@shared/contracts";
import {
  resultEvent,
  type CommandWithoutId,
} from "../../lib/runtimeCommands";

type WorkspaceEntriesResult = Extract<
  Extract<ServerEvent, { type: "request.result" }>["result"],
  { kind: "workspace.entries" }
>;

interface WorkspaceFilesOptions {
  project: Project | null;
  conversation: Conversation | null;
  online: boolean;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  setActionError: (message: string | null) => void;
}

export function useWorkspaceFiles({
  project,
  conversation,
  online,
  request,
  setActionError,
}: WorkspaceFilesOptions) {
  const [workspaceEntries, setWorkspaceEntries] = useState<WorkspaceEntry[]>([]);
  const [mentionResults, setMentionResults] = useState<WorkspaceEntry[]>([]);
  const [entriesTruncated, setEntriesTruncated] = useState(false);
  const [filePreview, setFilePreview] =
    useState<WorkspaceFilePreview | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [filePreviewLoading, setFilePreviewLoading] = useState(false);
  const [filePreviewError, setFilePreviewError] = useState<string | null>(null);
  const [projectActions, setProjectActions] = useState<ProjectAction[]>([]);
  const fileListRequestGenerationRef = useRef(0);
  const filePreviewRequestGenerationRef = useRef(0);

  const requestWorkspaceEntries = useCallback(async (options: {
    directory?: string;
    query?: string;
  } = {}): Promise<WorkspaceEntriesResult> => {
    if (!project?.id) {
      throw new Error("Select a project before browsing files.");
    }
    const event = resultEvent(await request({
      type: "workspace.entries",
      payload: {
        projectId: project.id,
        conversationId: conversation?.id,
        ...(options.directory ? { directory: options.directory } : {}),
        ...(options.query?.trim() ? { query: options.query.trim() } : {}),
      },
    }));
    if (event.result.kind !== "workspace.entries") {
      throw new Error("Unexpected file response.");
    }
    return event.result;
  }, [conversation?.id, project?.id, request]);

  const loadFiles = useCallback(async () => {
    const generation = ++fileListRequestGenerationRef.current;
    setFilesLoading(true);
    setFilesError(null);
    try {
      const result = await requestWorkspaceEntries();
      if (fileListRequestGenerationRef.current !== generation) return;
      setWorkspaceEntries(result.entries);
      setEntriesTruncated(result.truncated);
    } catch (error) {
      if (fileListRequestGenerationRef.current === generation) {
        setFilesError(
          error instanceof Error ? error.message : "Files could not be loaded.",
        );
      }
      throw error;
    } finally {
      if (fileListRequestGenerationRef.current === generation) {
        setFilesLoading(false);
      }
    }
  }, [requestWorkspaceEntries]);

  const loadActions = useCallback(async () => {
    if (!project?.id) return;
    try {
      const event = resultEvent(await request({
        type: "project.actions",
        payload: {
          projectId: project.id,
          conversationId: conversation?.id,
        },
      }));
      if (event.result.kind === "project.actions") {
        setProjectActions(event.result.actions);
      }
    } catch {
      setProjectActions([]);
    }
  }, [conversation?.id, project?.id, request]);

  useEffect(() => {
    fileListRequestGenerationRef.current += 1;
    filePreviewRequestGenerationRef.current += 1;
    setWorkspaceEntries([]);
    setFilePreview(null);
    setSelectedFile(null);
    setProjectActions([]);
    setFilesError(null);
    setFilePreviewError(null);
    setFilesLoading(false);
    setFilePreviewLoading(false);
    if (!project || !online) return;
    void Promise.allSettled([loadFiles(), loadActions()]);
  }, [conversation?.id, loadActions, loadFiles, online, project?.id]);

  const selectWorkspaceFile = useCallback((path: string) => {
    if (!project) return;
    const generation = ++filePreviewRequestGenerationRef.current;
    setSelectedFile(path);
    setFilePreview(null);
    setFilePreviewError(null);
    setFilePreviewLoading(true);
    void request({
      type: "workspace.file.read",
      payload: {
        projectId: project.id,
        conversationId: conversation?.id,
        path,
      },
    }).then(resultEvent).then((event) => {
      if (
        filePreviewRequestGenerationRef.current === generation
        && event.result.kind === "workspace.file"
      ) {
        setFilePreview(event.result.file);
      }
    }).catch((error) => {
      if (filePreviewRequestGenerationRef.current !== generation) return;
      const message = error instanceof Error
        ? error.message
        : "The file could not be opened.";
      setFilePreviewError(message);
      setActionError(message);
    }).finally(() => {
      if (filePreviewRequestGenerationRef.current === generation) {
        setFilePreviewLoading(false);
      }
    });
  }, [conversation?.id, project, request, setActionError]);

  const searchMentions = useCallback((query: string) => {
    if (!project || !query.trim()) {
      setMentionResults([]);
      return;
    }
    void request({
      type: "workspace.entries",
      payload: {
        projectId: project.id,
        conversationId: conversation?.id,
        query: query.trim(),
      },
    }).then(resultEvent).then((event) => {
      if (event.result.kind === "workspace.entries") {
        setMentionResults(event.result.entries.slice(0, 8));
      }
    }).catch(() => setMentionResults([]));
  }, [conversation?.id, project, request]);

  return {
    workspaceEntries,
    mentionResults,
    entriesTruncated,
    filePreview,
    selectedFile,
    filesLoading,
    filesError,
    filePreviewLoading,
    filePreviewError,
    projectActions,
    requestWorkspaceEntries,
    loadFiles,
    selectWorkspaceFile,
    searchMentions,
  };
}
