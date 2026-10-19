import { WORKSPACE_CONTENT_SEARCH_LIMITS } from "./workspace";

type UnknownRecord = Record<string, unknown>;

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function workspaceContentMatch(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const match = value as UnknownRecord;
  return typeof match.projectPath === "string"
    && match.projectPath.length > 0
    && typeof match.snippet === "string"
    && match.snippet.length <= WORKSPACE_CONTENT_SEARCH_LIMITS.snippetCharacters
    && positiveInteger(match.line)
    && positiveInteger(match.column);
}

/** Validates a `workspace.search.content` request result from the runtime. */
export function workspaceContentSearchPage(value: UnknownRecord): boolean {
  return Array.isArray(value.matches)
    && value.matches.length <= WORKSPACE_CONTENT_SEARCH_LIMITS.maxResults
    && value.matches.every(workspaceContentMatch)
    && typeof value.truncated === "boolean";
}
