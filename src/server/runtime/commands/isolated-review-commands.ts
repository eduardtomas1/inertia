import type WebSocket from "ws";

import type {
  ProviderInfo,
  ServerEvent,
} from "../../../shared/contracts";
import {
  diffFileFingerprint,
  parseUnifiedDiff,
} from "../../../shared/diff-review";
import type { RuntimeStore } from "../../database";
import { getUnifiedDiff, GitError } from "../../git";
import {
  buildReviewSummaryPrompt,
  DEFAULT_REVIEW_SUMMARY_TIMEOUT_MS,
  parseReviewSummaryResult,
  requireCurrentReviewSummaryFingerprint,
} from "../../review-summary";
import { RuntimeRequestError } from "../../runtime-errors";
import type { RuntimeSecureFileBroker } from "../../secure-files";
import {
  IsolatedRunError,
  type IsolatedRunController,
  isolatedRunSelection,
} from "../reviews/isolated-run-controller";
import type { TurnController } from "../turns/turn-controller";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";
import {
  assembleReadOnlyReviewRequest,
  captureRequiredCheckpoint,
  reconcileReviews,
  selectedReviewContext,
} from "./review-support";

function providerLabel(providerId: ProviderInfo["id"]): string {
  return providerId === "codex"
    ? "Codex"
    : providerId === "claude"
      ? "Claude"
      : providerId === "cursor"
        ? "Cursor"
        : "OpenCode";
}

export interface IsolatedReviewCommandDependencies {
  store: RuntimeStore;
  turns: TurnController;
  isolatedRuns: IsolatedRunController<WebSocket>;
  secureFiles: RuntimeSecureFileBroker;
  dataDirectory: string;
  enableProviders: boolean;
  reviewSummaryTimeoutMs?: number;
  providerInfo(): readonly ProviderInfo[];
  publicError(error: unknown): string;
  broadcastSnapshot(): void;
  send(socket: WebSocket, event: ServerEvent): void;
}

export function createIsolatedReviewCommandHandler(
  dependencies: IsolatedReviewCommandDependencies,
): RuntimeCommandHandler {
  const pendingSelectionQuestions = new Map<string, {
    cancelled: boolean;
    abort: AbortController;
  }>();
  return defineRuntimeCommandHandler([
    "review.selection.ask",
    "review.selection.revise",
    "review.selection.cancel",
    "review.summary.generate",
    "review.summary.cancel",
  ], async (socket, command) => {
    switch (command.type) {
      case "review.selection.ask": {
        if (!dependencies.enableProviders) {
          throw new RuntimeRequestError(
            "Read-only review questions are unavailable in this runtime.",
          );
        }
        const conversation = dependencies.store.conversation(
          command.payload.conversationId,
        );
        if (
          dependencies.turns.isActive(conversation.id)
          || dependencies.isolatedRuns.has(conversation.id)
          || pendingSelectionQuestions.has(conversation.id)
        ) {
          throw new RuntimeRequestError(
            "Wait for the current agent or review turn to finish first.",
          );
        }
        const provider = dependencies.providerInfo().find(
          ({ id }) => id === conversation.providerId,
        );
        if (!provider?.canRun) {
          throw new RuntimeRequestError(
            provider?.statusMessage
              ?? "The selected review agent is unavailable.",
          );
        }
        const pending = {
          cancelled: false,
          abort: new AbortController(),
        };
        pendingSelectionQuestions.set(conversation.id, pending);
        try {
          const context = await selectedReviewContext(
            dependencies.store,
            command.payload,
            "ask",
            dependencies.secureFiles,
            pending.abort.signal,
          );
          if (pending.cancelled) {
            dependencies.send(socket, {
              type: "request.ok",
              requestId: command.requestId,
            });
            return "handled";
          }
          const assembled = assembleReadOnlyReviewRequest(
            dependencies.store.conversationPath(conversation.id),
            context.visibleContent,
            context.requestContext,
          );
          const completionPromise = dependencies.isolatedRuns.run({
            kind: "selection-ask",
            projectId: conversation.projectId,
            conversationId: conversation.id,
            owner: socket,
            selection: isolatedRunSelection(conversation),
            request: {
              visibleContent: assembled.visibleContent,
              executionPrompt: assembled.executionPrompt,
            },
            label:
              `${providerLabel(conversation.providerId)} · read-only question`,
            detail:
              `${context.filePath} · ${context.selectedLineCount} selected lines`,
            successDetail:
              `${context.filePath} reviewed without a resumable session`,
            toolPolicy: "read-only",
            interactionPolicy: "fail-closed",
            outputLimitChars: 512_000,
            onResult: (output, { assertActive }) => {
              const answer = output.text.trim();
              if (!answer) {
                throw new RuntimeRequestError(
                  "The review agent returned an empty answer.",
                );
              }
              assertActive();
              return {
                conversationId: conversation.id,
                repositoryPath: command.payload.repositoryPath ?? ".",
                fingerprint: context.fingerprint,
                filePath: context.filePath,
                hunkId: context.hunkId,
                selectedLineCount: context.selectedLineCount,
                question: assembled.visibleContent,
                answer: answer.slice(0, 512_000),
                providerId: conversation.providerId,
                modelSelection: output.modelSelection,
                generatedAt: new Date().toISOString(),
              };
            },
          });
          const completion = await completionPromise;
          if (pending.cancelled) {
            dependencies.send(socket, {
              type: "request.ok",
              requestId: command.requestId,
            });
            return "handled";
          }
          dependencies.send(socket, {
            type: "request.result",
            requestId: command.requestId,
            result: {
              kind: "review.selection.answer",
              answer: completion.value,
            },
          });
        } catch (error) {
          if (
            pending.cancelled
            && !(error instanceof GitError && error.code === "operation-failed")
          ) {
            dependencies.send(socket, {
              type: "request.ok",
              requestId: command.requestId,
            });
            return "handled";
          }
          if (
            error instanceof IsolatedRunError
            && error.reason === "cancelled"
          ) {
            dependencies.send(socket, {
              type: "request.ok",
              requestId: command.requestId,
            });
            return "handled";
          }
          if (error instanceof IsolatedRunError) {
            throw new RuntimeRequestError(error.message);
          }
          throw error;
        } finally {
          if (pendingSelectionQuestions.get(conversation.id) === pending) {
            pendingSelectionQuestions.delete(conversation.id);
          }
        }
        return "handled";
      }
      case "review.selection.cancel": {
        const conversation = dependencies.store.conversation(
          command.payload.conversationId,
        );
        const stopped = dependencies.isolatedRuns.stopConversation(
          conversation.id,
          "selection-ask",
        );
        const pending = pendingSelectionQuestions.get(conversation.id);
        if (pending) {
          pending.cancelled = true;
          pending.abort.abort();
        }
        if (!stopped && !pending) {
          throw new RuntimeRequestError(
            "This thread does not have an active review question.",
          );
        }
        dependencies.send(socket, {
          type: "request.ok",
          requestId: command.requestId,
        });
        return "handled";
      }
      case "review.selection.revise": {
        if (!dependencies.enableProviders) {
          throw new RuntimeRequestError(
            "Revision requests are unavailable in this runtime.",
          );
        }
        const conversation = dependencies.store.conversation(
          command.payload.conversationId,
        );
        if (
          dependencies.turns.isActive(conversation.id)
          || dependencies.isolatedRuns.has(conversation.id)
        ) {
          throw new RuntimeRequestError(
            "Wait for the current agent or review turn to finish first.",
          );
        }
        const provider = dependencies.providerInfo().find(
          ({ id }) => id === conversation.providerId,
        );
        if (!provider?.canRun) {
          throw new RuntimeRequestError(
            provider?.statusMessage
              ?? "The selected agent is unavailable.",
          );
        }
        if (!dependencies.store.conversationWork.reserve(conversation.id)) {
          throw new RuntimeRequestError(
            "End the resumed provider terminal before starting another agent task for this chat.",
          );
        }
        try {
          if (
            dependencies.turns.isActive(conversation.id)
            || dependencies.isolatedRuns.has(conversation.id)
          ) {
            throw new RuntimeRequestError(
              "Wait for the current agent or review turn to finish first.",
            );
          }
          const context = await selectedReviewContext(
            dependencies.store,
            command.payload,
            "revision",
            dependencies.secureFiles,
          );
          const beforeFiles = Object.fromEntries(
            parseUnifiedDiff(context.patch).files.map((file) => [
              file.path,
              diffFileFingerprint(file),
            ]),
          );
          const checkpoint = await captureRequiredCheckpoint(
            dependencies.store,
            dependencies.dataDirectory,
            conversation.id,
            `Before revision · ${context.filePath}`,
            dependencies.publicError,
          );
          const queued = dependencies.turns.queue({
            conversationId: conversation.id,
            content: context.visibleContent,
            context: context.requestContext,
            internalInstructions: [{
              label: "selected-diff-revision-scope",
              text: "Treat the selected lines as the requested focus, not a perfect technical write fence. Avoid unrelated files and hunks, and report any necessary spillover. A recovery checkpoint was created before this turn.",
            }],
            checkpointId: checkpoint.id,
            onSettled: async (status, turnId) => {
              let audit =
                "The refreshed diff could not be audited automatically. Use the recovery checkpoint if the result is not acceptable.";
              try {
                const current = await getUnifiedDiff(
                  dependencies.store.conversationPath(conversation.id),
                  { ignoreWhitespace: command.payload.ignoreWhitespace },
                  undefined,
                  dependencies.secureFiles,
                );
                if (!current.truncated) {
                  reconcileReviews(
                    dependencies.store,
                    conversation.id,
                    current.text,
                  );
                  const afterFiles = Object.fromEntries(
                    parseUnifiedDiff(current.text).files.map((file) => [
                      file.path,
                      diffFileFingerprint(file),
                    ]),
                  );
                  const outsidePaths = [
                    ...new Set([
                      ...Object.keys(beforeFiles),
                      ...Object.keys(afterFiles),
                    ]),
                  ]
                    .filter((path) => (
                      path !== context.filePath
                      && beforeFiles[path] !== afterFiles[path]
                    ))
                    .sort();
                  audit = outsidePaths.length > 0
                    ? `Potential unrelated changes were detected outside the selected file: ${outsidePaths.join(", ")}. Review them before committing.`
                    : "No changes outside the selected file were detected automatically. Review other hunks in the selected file because line boundaries are guidance, not a technical write fence.";
                }
              } catch {
                // The persistent checkpoint remains the recovery path.
              }
              const outcome = status === "completed"
                ? "completed"
                : status === "cancelled"
                  ? "was cancelled"
                  : "failed";
              dependencies.store.createMessage(
                conversation.id,
                `Revision ${outcome}. Scope: ${context.filePath} · ${context.hunkHeader} · ${context.selectedLineCount} selected lines. ${audit} Recovery checkpoint: ${checkpoint.label}.`,
                "system",
                [],
                turnId,
              );
            },
          });
          dependencies.send(socket, {
            type: "request.ok",
            requestId: command.requestId,
          });
          dependencies.broadcastSnapshot();
          dependencies.turns.start(queued.turn.id);
          return "handled";
        } finally {
          dependencies.store.conversationWork.release(conversation.id);
        }
      }
      case "review.summary.generate": {
        if (!dependencies.enableProviders) {
          throw new RuntimeRequestError(
            "Agent summaries are unavailable in this runtime.",
          );
        }
        const conversation = dependencies.store.conversation(
          command.payload.conversationId,
        );
        if (conversation.projectId !== command.payload.projectId) {
          throw new RuntimeRequestError(
            "The thread does not belong to this project.",
          );
        }
        if (dependencies.turns.isActive(conversation.id)) {
          throw new RuntimeRequestError(
            "Wait for the current agent or read-only review to finish before summarizing its changes.",
          );
        }
        if (dependencies.isolatedRuns.has(conversation.id)) {
          throw new RuntimeRequestError(
            "An isolated review is already running for this thread.",
          );
        }
        const provider = dependencies.providerInfo().find(
          ({ id }) => id === conversation.providerId,
        );
        if (!provider?.canRun) {
          throw new RuntimeRequestError(
            provider?.statusMessage
              ?? "The selected review agent is unavailable.",
          );
        }
        try {
          const diff = await getUnifiedDiff(
            dependencies.store.conversationPath(conversation.id),
            { ignoreWhitespace: command.payload.ignoreWhitespace },
            undefined,
            dependencies.secureFiles,
          );
          if (diff.truncated) {
            throw new RuntimeRequestError(
              "The diff preview is truncated. Reduce or commit part of the change set before generating a complete summary.",
            );
          }
          const structured = parseUnifiedDiff(diff.text);
          if (structured.fingerprint !== command.payload.fingerprint) {
            throw new RuntimeRequestError(
              "The changes moved before the review started. Refresh and try again.",
            );
          }
          if (structured.files.length === 0) {
            throw new RuntimeRequestError(
              "There are no changes to summarize.",
            );
          }
          const prompt = buildReviewSummaryPrompt(
            diff.text,
            structured.files,
          );
          const selectedReviewModel = conversation.model
            ? provider.models.find(
                ({ id }) => id === conversation.model,
              )?.id ?? conversation.model
            : (
              provider.models.find(({ isDefault }) => isDefault)
              ?? provider.models[0]
            )?.id ?? null;
          const completion = await dependencies.isolatedRuns.run({
            kind: "diff-summary",
            projectId: conversation.projectId,
            conversationId: conversation.id,
            owner: socket,
            selection: isolatedRunSelection(
              conversation,
              selectedReviewModel,
            ),
            request: {
              visibleContent: null,
              executionPrompt: prompt,
            },
            label:
              `${providerLabel(conversation.providerId)} · read-only diff summary${conversation.model ? ` · ${conversation.model}` : ""}`,
            detail:
              `${structured.files.length} ${structured.files.length === 1 ? "file" : "files"} · isolated session`,
            successDetail:
              `${structured.files.length} ${structured.files.length === 1 ? "file" : "files"} summarized · isolated session`,
            toolPolicy: "none",
            interactionPolicy: "fail-closed",
            timeoutMs: dependencies.reviewSummaryTimeoutMs
              ?? DEFAULT_REVIEW_SUMMARY_TIMEOUT_MS,
            outputLimitChars: 512_000,
            onResult: async (output, { assertActive }) => {
              const summary = parseReviewSummaryResult(
                conversation.id,
                {
                  providerId: conversation.providerId,
                  harnessId: output.harnessId,
                  backendProfileId: output.backendProfileId,
                  model: output.model,
                },
                structured.fingerprint,
                structured.files,
                output.text,
              );
              const current = await getUnifiedDiff(
                dependencies.store.conversationPath(conversation.id),
                { ignoreWhitespace: command.payload.ignoreWhitespace },
                undefined,
                dependencies.secureFiles,
              );
              requireCurrentReviewSummaryFingerprint(
                structured.fingerprint,
                current.text,
                current.truncated,
              );
              assertActive();
              dependencies.store.upsertReviewSummary(summary);
              return summary;
            },
          });
          dependencies.send(socket, {
            type: "request.result",
            requestId: command.requestId,
            result: {
              kind: "review.summary",
              summary: completion.value,
            },
          });
        } catch (error) {
          if (
            error instanceof IsolatedRunError
            && error.reason === "cancelled"
          ) {
            dependencies.send(socket, {
              type: "request.ok",
              requestId: command.requestId,
            });
            return "handled";
          }
          if (error instanceof IsolatedRunError) {
            throw new RuntimeRequestError(error.message);
          }
          throw error;
        }
        return "handled";
      }
      case "review.summary.cancel": {
        const conversation = dependencies.store.conversation(
          command.payload.conversationId,
        );
        if (
          !dependencies.isolatedRuns.stopConversation(
            conversation.id,
            "diff-summary",
          )
        ) {
          throw new RuntimeRequestError(
            "This thread does not have an active change summary.",
          );
        }
        dependencies.send(socket, {
          type: "request.ok",
          requestId: command.requestId,
        });
        return "handled";
      }
      default:
        return "not-handled";
    }
  });
}
