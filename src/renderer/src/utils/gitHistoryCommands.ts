import type { ServerEvent } from "@shared/contracts";
import type { GitBlamePage, GitCommitDetail, GitLogPage } from "@shared/contracts/git-history";
import { resultEvent, type CommandWithoutId } from "../lib/runtimeCommands";

export type GitHistoryRun = (key: string, command: CommandWithoutId) => Promise<ServerEvent>;

/**
 * The repository a history view reads. Omitting repositoryPath reads the
 * chat checkout (or project root); a nested repository carries the
 * authorityRef issued by its last workspace status refresh.
 */
export interface GitHistoryScope {
  projectId: string;
  conversationId?: string;
  repositoryPath?: string;
  authorityRef?: string;
}

function scopePayload(scope: GitHistoryScope): GitHistoryScope {
  return {
    projectId: scope.projectId,
    ...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
    ...(scope.repositoryPath && scope.authorityRef
      ? { repositoryPath: scope.repositoryPath, authorityRef: scope.authorityRef }
      : {}),
  };
}

export async function requestGitLog(
  run: GitHistoryRun,
  scope: GitHistoryScope,
  page: { cursor?: string | null; limit?: number; path?: string } = {},
): Promise<GitLogPage> {
  const event = resultEvent(await run("git.log", {
    type: "git.log",
    payload: {
      ...scopePayload(scope),
      ...(page.cursor ? { cursor: page.cursor } : {}),
      ...(page.limit ? { limit: page.limit } : {}),
      ...(page.path ? { path: page.path } : {}),
    },
  }));
  if (event.result.kind !== "git.log") throw new Error("The local service returned unexpected history.");
  return event.result.page;
}

export async function requestGitCommit(
  run: GitHistoryRun,
  scope: GitHistoryScope,
  sha: string,
): Promise<GitCommitDetail> {
  const event = resultEvent(await run("git.commit.show", {
    type: "git.commit.show",
    payload: { ...scopePayload(scope), sha },
  }));
  if (event.result.kind !== "git.commit.show") throw new Error("The local service returned an unexpected commit.");
  return event.result.commit;
}

export async function requestGitBlame(
  run: GitHistoryRun,
  scope: GitHistoryScope,
  request: { path: string; startLine?: number; endLine?: number },
): Promise<GitBlamePage> {
  const event = resultEvent(await run("git.blame", {
    type: "git.blame",
    payload: { ...scopePayload(scope), ...request },
  }));
  if (event.result.kind !== "git.blame") throw new Error("The local service returned unexpected blame.");
  return event.result.blame;
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}
