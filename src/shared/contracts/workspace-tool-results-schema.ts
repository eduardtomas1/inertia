import { gitHistoryResultValidators } from "./git-history";
import { isTerminalPathResolveResult } from "./terminal-links";
import { workspaceContentSearchPage } from "./workspace-content-search-schema";
import { worktreeResultValidators } from "./worktree-results-schema";

export const workspaceToolResultValidators = {
  "workspace.path": isTerminalPathResolveResult,
  "workspace.search.content": workspaceContentSearchPage,
  ...worktreeResultValidators,
  ...gitHistoryResultValidators,
};
