import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Conversation,
  ConversationDetail,
  DiffReviewNote,
  DiffReviewState,
  DiffReversalOperation,
  DiffSelectionReviewAnswer,
  GitDiffSnapshot,
  Project,
  ServerEvent,
} from "@shared/contracts";
import { parseUnifiedDiff } from "@shared/diff-review";
import type { DiffSelection } from "../../components/ChangesPanel";
import {
  resultEvent,
  type CommandWithoutId,
} from "../../lib/runtimeCommands";

interface WorkspaceReviewOptions {
  project: Project | null;
  conversation: Conversation | null;
  detail: ConversationDetail | null;
  gitDiff: GitDiffSnapshot | null;
  ignoreWhitespace: boolean;
  confirmDestructiveActions: boolean;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  run: (key: string, command: CommandWithoutId) => Promise<ServerEvent>;
  setGitDiff: (diff: GitDiffSnapshot | null) => void;
  loadGit: () => Promise<void>;
}

export function useWorkspaceReview({
  project,
  conversation,
  detail,
  gitDiff,
  ignoreWhitespace,
  confirmDestructiveActions,
  request,
  run,
  setGitDiff,
  loadGit,
}: WorkspaceReviewOptions) {
  const [pendingDiffContext, setPendingDiffContext] = useState<string | null>(
    null,
  );
  const [lastDiffReversal, setLastDiffReversal] =
    useState<DiffReversalOperation | null>(null);
  const [selectionReviewAnswer, setSelectionReviewAnswer] =
    useState<DiffSelectionReviewAnswer | null>(null);
  const authority = `${project?.id ?? ""}:${conversation?.id ?? ""}`;
  const authorityRef = useRef(authority);
  authorityRef.current = authority;

  const structuredDiff = useMemo(
    () => parseUnifiedDiff(gitDiff?.patch ?? ""),
    [gitDiff?.patch],
  );

  useEffect(() => {
    setSelectionReviewAnswer((current) => (
      current
      && current.conversationId === conversation?.id
      && current.fingerprint === structuredDiff.fingerprint
        ? current
        : null
    ));
  }, [conversation?.id, structuredDiff.fingerprint]);

  useEffect(() => {
    setPendingDiffContext(null);
    setLastDiffReversal(null);
  }, [conversation?.id]);

  const reviewSummary = useMemo(
    () => detail?.reviewSummaries.find((summary) => (
      summary.conversationId === conversation?.id
      && summary.fingerprint === structuredDiff.fingerprint
    )) ?? null,
    [conversation?.id, detail?.reviewSummaries, structuredDiff.fingerprint],
  );
  const reviewStates = useMemo(
    () => detail?.reviewStates ?? [],
    [detail?.reviewStates],
  );
  const reviewNotes = useMemo(
    () => detail?.reviewNotes ?? [],
    [detail?.reviewNotes],
  );

  const askAboutDiff = useCallback(async (
    selection: DiffSelection,
    comment: string,
  ) => {
    if (!project || !conversation) return;
    const owner = `${project.id}:${conversation.id}`;
    setSelectionReviewAnswer(null);
    const event = await run("review.selection.ask", {
      type: "review.selection.ask",
      payload: {
        projectId: project.id,
        conversationId: conversation.id,
        repositoryPath: selection.repositoryPath ?? ".",
        fingerprint: selection.fingerprint,
        filePath: selection.file.path,
        hunkId: selection.hunk.id,
        lineIds: selection.lineIds,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
        ignoreWhitespace,
      },
    });
    if (event.type === "request.ok") return;
    const result = resultEvent(event).result;
    if (result.kind !== "review.selection.answer") {
      throw new Error(
        "The local service returned an unexpected review answer.",
      );
    }
    if (authorityRef.current === owner) {
      setSelectionReviewAnswer(result.answer);
    }
  }, [conversation, ignoreWhitespace, project, run]);

  const requestDiffRevision = useCallback(async (
    selection: DiffSelection,
    comment: string,
  ) => {
    if (!project || !conversation) return;
    await run("review.selection.revise", {
      type: "review.selection.revise",
      payload: {
        projectId: project.id,
        conversationId: conversation.id,
        repositoryPath: selection.repositoryPath ?? ".",
        fingerprint: selection.fingerprint,
        filePath: selection.file.path,
        hunkId: selection.hunk.id,
        lineIds: selection.lineIds,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
        ignoreWhitespace,
      },
    });
  }, [conversation, ignoreWhitespace, project, run]);

  const setDiffReviewState = useCallback(async (
    state: Omit<
      DiffReviewState,
      "conversationId" | "stale" | "updatedAt"
    >,
  ) => {
    if (!conversation) return;
    await run("review.state.set", {
      type: "review.state.set",
      payload: {
        conversationId: conversation.id,
        repositoryPath: state.repositoryPath ?? ".",
        scope: state.scope,
        path: state.path,
        hunkId: state.hunkId,
        targetFingerprint: state.targetFingerprint,
        reviewed: state.reviewed,
        ignoreWhitespace,
      },
    });
  }, [conversation, ignoreWhitespace, run]);

  const createDiffReviewNote = useCallback(async (
    note: Omit<
      DiffReviewNote,
      "id" | "conversationId" | "stale" | "createdAt" | "updatedAt"
    >,
  ) => {
    if (!conversation) return;
    await run("review.note.create", {
      type: "review.note.create",
      payload: {
        conversationId: conversation.id,
        repositoryPath: note.repositoryPath ?? ".",
        path: note.path,
        hunkId: note.hunkId,
        lineIds: note.lineIds,
        targetFingerprint: note.targetFingerprint,
        body: note.body,
        ignoreWhitespace,
      },
    });
  }, [conversation, ignoreWhitespace, run]);

  const updateDiffReviewNote = useCallback(async (
    noteId: string,
    body: string,
  ) => {
    if (!conversation) return;
    await run("review.note.update", {
      type: "review.note.update",
      payload: { conversationId: conversation.id, noteId, body },
    });
  }, [conversation, run]);

  const deleteDiffReviewNote = useCallback(async (noteId: string) => {
    if (!conversation) return;
    await run("review.note.delete", {
      type: "review.note.delete",
      payload: { conversationId: conversation.id, noteId },
    });
  }, [conversation, run]);

  const revertDiffSelection = useCallback(async (
    selection: DiffSelection,
    comment: string,
  ) => {
    if (!project) return;
    const owner = `${project.id}:${conversation?.id ?? ""}`;
    const inspected = resultEvent(await run("git.selection.inspect", {
      type: "git.selection.inspect",
      payload: {
        projectId: project.id,
        ...(conversation ? { conversationId: conversation.id } : {}),
        repositoryPath: selection.repositoryPath ?? ".",
        fingerprint: selection.fingerprint,
        filePath: selection.file.path,
        hunkId: selection.hunk.id,
        lineIds: selection.lineIds,
        ignoreWhitespace,
      },
    }));
    if (inspected.result.kind !== "git.reversal.plan") {
      throw new Error(
        "The local service returned an unexpected reversal plan.",
      );
    }
    const plan = inspected.result.plan;
    if (confirmDestructiveActions) {
      const selectedRepositoryPath = selection.repositoryPath ?? ".";
      const displayPath = selectedRepositoryPath === "."
        ? plan.filePath
        : `${selectedRepositoryPath}/${plan.filePath}`;
      const layers = plan.affectedLayers.map((layer) =>
        layer === "index" ? "Git index (staged)" : "working tree"
      ).join(" and ");
      const confirmed = window.confirm([
        `Revert ${plan.changedLineCount} changed ${
          plan.changedLineCount === 1 ? "line" : "lines"
        } in ${displayPath}?`,
        "",
        `Hunk: ${plan.hunkHeader}`,
        `Selected lines: ${plan.selectedLineCount}`,
        `Affected Git layers: ${layers}`,
        "",
        "Inertia will create an immediate reversible backup before changing either layer.",
      ].join("\n"));
      if (!confirmed) return;
    }
    const reversed = resultEvent(await run("git.selection.revert", {
      type: "git.selection.revert",
      payload: {
        projectId: project.id,
        ...(conversation ? { conversationId: conversation.id } : {}),
        repositoryPath: selection.repositoryPath ?? ".",
        fingerprint: selection.fingerprint,
        filePath: selection.file.path,
        hunkId: selection.hunk.id,
        lineIds: selection.lineIds,
        expected: plan.validation,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
        ignoreWhitespace,
      },
    }));
    if (reversed.result.kind !== "git.reversal") {
      throw new Error(
        "The local service returned an unexpected reversal result.",
      );
    }
    if (authorityRef.current !== owner) return;
    setGitDiff(reversed.result.diff);
    setLastDiffReversal(reversed.result.operation);
    await loadGit();
  }, [
    confirmDestructiveActions,
    conversation,
    ignoreWhitespace,
    loadGit,
    project,
    run,
    setGitDiff,
  ]);

  const undoDiffReversal = useCallback(async () => {
    if (!project || !lastDiffReversal) return;
    const owner = `${project.id}:${conversation?.id ?? ""}`;
    const restored = resultEvent(await run("git.selection.undo", {
      type: "git.selection.undo",
      payload: {
        projectId: project.id,
        ...(conversation ? { conversationId: conversation.id } : {}),
        repositoryPath: lastDiffReversal.repositoryPath ?? ".",
        operationId: lastDiffReversal.id,
      },
    }));
    if (restored.result.kind !== "git.diff") {
      throw new Error(
        "The local service returned an unexpected Undo result.",
      );
    }
    if (authorityRef.current !== owner) return;
    setGitDiff(restored.result.diff);
    setLastDiffReversal(null);
    await loadGit();
  }, [
    conversation,
    lastDiffReversal,
    loadGit,
    project,
    run,
    setGitDiff,
  ]);

  const generateReviewSummary = useCallback(async () => {
    if (!project || !conversation || structuredDiff.files.length === 0) return;
    await run("review.summary.generate", {
      type: "review.summary.generate",
      payload: {
        projectId: project.id,
        conversationId: conversation.id,
        fingerprint: structuredDiff.fingerprint,
        ignoreWhitespace,
      },
    });
  }, [conversation, ignoreWhitespace, project, run, structuredDiff]);

  const cancelReviewSummary = useCallback(async () => {
    if (!conversation) return;
    await request({
      type: "review.summary.cancel",
      payload: { conversationId: conversation.id },
    });
  }, [conversation, request]);

  return {
    pendingDiffContext,
    setPendingDiffContext,
    lastDiffReversal,
    selectionReviewAnswer,
    setSelectionReviewAnswer,
    structuredDiff,
    reviewSummary,
    reviewStates,
    reviewNotes,
    askAboutDiff,
    requestDiffRevision,
    setDiffReviewState,
    createDiffReviewNote,
    updateDiffReviewNote,
    deleteDiffReviewNote,
    revertDiffSelection,
    undoDiffReversal,
    generateReviewSummary,
    cancelReviewSummary,
  };
}
