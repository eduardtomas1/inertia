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
import type { WorkspaceFileLocation } from "../../utils/workspaceFileReference";
import {
  workspaceFileWriteFitsRuntimeFrame,
  type WorkspaceFileWriteIdentity,
} from "../../utils/workspaceFileWrite";
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
  const [selectedFileLocation, setSelectedFileLocation] =
    useState<WorkspaceFileLocation | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [filePreviewLoading, setFilePreviewLoading] = useState(false);
  const [filePreviewError, setFilePreviewError] = useState<string | null>(null);
  const [projectActions, setProjectActions] = useState<ProjectAction[]>([]);
  const fileListRequestGenerationRef = useRef(0);
  const filePreviewRequestGenerationRef = useRef(0);
  const actionsRequestGenerationRef = useRef(0);
  const automaticallyLoadedAuthorityRef = useRef<string | null>(null);
  const authority = `${enabled}\0${project?.id}\0${conversation?.id}`;
  const authorityRef = useRef(authority);
  authorityRef.current = authority;
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
    setSelectedFileLocation(null);
    setProjectActions([]);
    setFilesError(null);
    setFilePreviewError(null);
    setFilesLoading(false);
    setFilePreviewLoading(false);
  }, [
    conversation?.id,
    enabled,
    project?.id,
  ]);

  useEffect(() => {
    fileListRequestGenerationRef.current += 1;
    filePreviewRequestGenerationRef.current += 1;
    actionsRequestGenerationRef.current += 1;
    setFilesLoading(false);
    setFilePreviewLoading(false);
    if (!enabled || !project?.id || !online) return;
    void loadActions();
  }, [enabled, loadActions, online, project?.id]);

  useEffect(() => {
    if (!online) {
      automaticallyLoadedAuthorityRef.current = null;
      return;
    }
    if (!enabled || !project?.id || !loadOnMount) return;
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

  const selectWorkspaceFile = useCallback((
    path: string,
    requestedLocation?: WorkspaceFileLocation,
    literalPath = false,
  ) => {
    if (!project) return;
    void import("./selectWorkspaceFile").then(
      ({ selectWorkspaceFile }) => selectWorkspaceFile([
        path,
        requestedLocation,
        literalPath,
        request,
        project.id,
        conversation?.id,
        authorityRef,
        authority,
        filePreviewRequestGenerationRef,
        setSelectedFile,
        setSelectedFileLocation,
        setFilePreview,
        setFilePreviewError,
        setFilePreviewLoading,
        setActionError,
      ]),
    ).catch(() => undefined);
  }, [authority, conversation?.id, project, request, setActionError]);

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
    const identity: WorkspaceFileWriteIdentity = {
      projectId: project.id,
      conversationId: conversation?.id,
      path,
      authorityRef: filePreview.authorityRef,
      expectedDigest,
    };
    if (!workspaceFileWriteFitsRuntimeFrame(identity, content)) {
      throw new Error(
        "This edit is too large to send safely. Shorten the file and try again.",
      );
    }
    const generation = filePreviewRequestGenerationRef.current;
    const { file: savedFile, location } = await import(
      "./selectWorkspaceFile"
    ).then(({ saveWorkspaceFile }) => saveWorkspaceFile(
      request,
      identity,
      content,
      selectedFileLocation,
    ));
    if (
      filePreviewRequestGenerationRef.current === generation
      && authorityRef.current === authority
      && selectedFile === path
    ) {
      setFilePreview(savedFile);
      setSelectedFileLocation(location);
      setFilePreviewError(null);
    }
    return savedFile;
  }, [
    authority,
    conversation?.id,
    filePreview,
    project,
    request,
    selectedFile,
    selectedFileLocation,
  ]);

  const canSaveWorkspaceFile = useCallback((
    path: string,
    content: string,
    expectedDigest: string,
  ): boolean => {
    if (
      !project
      || !filePreview?.authorityRef
      || filePreview.path !== path
      || filePreview.contentDigest !== expectedDigest
    ) {
      return false;
    }
    return workspaceFileWriteFitsRuntimeFrame({
      projectId: project.id,
      conversationId: conversation?.id,
      path,
      authorityRef: filePreview.authorityRef,
      expectedDigest,
    }, content);
  }, [conversation?.id, filePreview, project]);

  return {
    workspaceEntries,
    mentionResults: mentions.mentionResults,
    entriesTruncated,
    filePreview,
    selectedFile,
    selectedFileLocation,
    filesLoading,
    filesError,
    filePreviewLoading,
    filePreviewError,
    projectActions,
    requestWorkspaceEntries,
    loadFiles,
    selectWorkspaceFile,
    canSaveWorkspaceFile,
    saveWorkspaceFile,
    searchMentions: mentions.searchMentions,
  };
}
