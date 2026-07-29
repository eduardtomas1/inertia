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
import {
  workspaceFileReferenceFallback,
} from "../../utils/workspaceFileReference";
import { useWorkspaceMentions } from "./useWorkspaceMentions";

type WorkspaceEntriesResult = Extract<
  Extract<ServerEvent, { type: "request.result" }>["result"],
  { kind: "workspace.entries" }
>;

interface WorkspaceFilesOptions {
  enabled: boolean;
  loadOnMount: boolean;
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
  enabled,
  loadOnMount,
}: WorkspaceFilesOptions) {
  const [workspaceEntries, setWorkspaceEntries] = useState<WorkspaceEntry[]>([]);
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
  const actionsRequestGenerationRef = useRef(0);
  const automaticallyLoadedAuthorityRef = useRef<string | null>(null);
  const mentions = useWorkspaceMentions({
    enabled,
    project,
    conversation,
    request,
  });

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
    const generation = ++actionsRequestGenerationRef.current;
    try {
      const event = resultEvent(await request({
        type: "project.actions",
        payload: {
          projectId: project.id,
          conversationId: conversation?.id,
        },
      }));
      if (
        actionsRequestGenerationRef.current === generation
        && event.result.kind === "project.actions"
      ) {
        setProjectActions(event.result.actions);
      }
    } catch {
      if (actionsRequestGenerationRef.current === generation) {
        setProjectActions([]);
      }
    }
  }, [conversation?.id, project?.id, request]);

  useEffect(() => {
    automaticallyLoadedAuthorityRef.current = null;
    fileListRequestGenerationRef.current += 1;
    filePreviewRequestGenerationRef.current += 1;
    actionsRequestGenerationRef.current += 1;
    setWorkspaceEntries([]);
    setFilePreview(null);
    setSelectedFile(null);
    setProjectActions([]);
    setFilesError(null);
    setFilePreviewError(null);
    setFilesLoading(false);
    setFilePreviewLoading(false);
    if (!enabled || !project?.id || !online) return;
    void loadActions();
  }, [
    conversation?.id,
    enabled,
    loadActions,
    online,
    project?.id,
  ]);

  useEffect(() => {
    if (!enabled || !project?.id || !online || !loadOnMount) return;
    const authority = `${project.id}\0${conversation?.id ?? ""}`;
    if (automaticallyLoadedAuthorityRef.current === authority) return;
    automaticallyLoadedAuthorityRef.current = authority;
    void loadFiles().catch(() => {
      if (automaticallyLoadedAuthorityRef.current === authority) {
        automaticallyLoadedAuthorityRef.current = null;
      }
    });
  }, [
    conversation?.id,
    enabled,
    loadFiles,
    loadOnMount,
    online,
    project?.id,
  ]);

  const selectWorkspaceFile = useCallback((path: string) => {
    if (!project) return;
    const generation = ++filePreviewRequestGenerationRef.current;
    setSelectedFile(path);
    setFilePreview(null);
    setFilePreviewError(null);
    setFilePreviewLoading(true);
    const readFile = async (
      candidate: string,
    ): Promise<WorkspaceFilePreview> => {
      const event = resultEvent(await request({
        type: "workspace.file.read",
        payload: {
          projectId: project.id,
          conversationId: conversation?.id,
          path: candidate,
        },
      }));
      if (event.result.kind !== "workspace.file") {
        throw new Error("Unexpected file response.");
      }
      return event.result.file;
    };
    const readReference = async (): Promise<WorkspaceFilePreview> => {
      try {
        return await readFile(path);
      } catch (literalError) {
        const fallback = workspaceFileReferenceFallback(path);
        if (!fallback) throw literalError;
        try {
          return await readFile(fallback);
        } catch {
          throw literalError;
        }
      }
    };
    void readReference().then((file) => {
      if (
        filePreviewRequestGenerationRef.current === generation
      ) {
        setSelectedFile(file.path);
        setFilePreview(file);
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

  const saveWorkspaceFile = useCallback(async (
    path: string,
    content: string,
    expectedDigest: string,
  ): Promise<WorkspaceFilePreview> => {
    if (!project) throw new Error("Select a project before editing files.");
    if (
      !filePreview?.authorityRef
      || filePreview.path !== path
      || filePreview.contentDigest !== expectedDigest
    ) {
      throw new Error("Reload this file before saving it.");
    }
    const generation = filePreviewRequestGenerationRef.current;
    const event = resultEvent(await request({
      type: "workspace.file.write",
      payload: {
        projectId: project.id,
        conversationId: conversation?.id,
        path,
        content,
        authorityRef: filePreview.authorityRef,
        expectedDigest,
      },
    }));
    if (event.result.kind !== "workspace.file") {
      throw new Error("The local service returned an unexpected file response.");
    }
    if (
      filePreviewRequestGenerationRef.current === generation
      && selectedFile === path
    ) {
      setFilePreview(event.result.file);
      setFilePreviewError(null);
    }
    return event.result.file;
  }, [conversation?.id, filePreview, project, request, selectedFile]);

  return {
    workspaceEntries,
    mentionResults: mentions.mentionResults,
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
    saveWorkspaceFile,
    searchMentions: mentions.searchMentions,
  };
}
