import { ISSUE_REPOSITORY, ISSUE_REPOSITORY_URL, type IssuePublicationFailure } from "./issue-report";

export const MANUAL_ISSUE_URL_LIMIT = 4_096;

export const ISSUE_GITHUB_MESSAGES: Record<IssuePublicationFailure, string> = {
  missing: "GitHub CLI is not installed. Install gh and run gh auth login, or open GitHub manually.",
  "signed-out": "GitHub CLI is not signed in. Run gh auth login in a terminal, or open GitHub manually.",
  offline: "GitHub could not be reached. Check your connection and try again.",
  "rate-limited": "GitHub is limiting requests right now. Wait a few minutes and try again.",
  repository: `The ${ISSUE_REPOSITORY} repository could not be reached or does not accept issues. Open GitHub manually instead.`,
  timeout: "GitHub did not respond in time. Try again, or open GitHub manually.",
  unknown: "The issue could not be created on GitHub. Try again, or open GitHub manually.",
};

export function manualIssueUrl(title: string, body?: string): string | null {
  const query = new URLSearchParams(body === undefined ? { title } : { title, body });
  const url = `${ISSUE_REPOSITORY_URL}/new?${query.toString()}`;
  return url.length <= MANUAL_ISSUE_URL_LIMIT ? url : null;
}
