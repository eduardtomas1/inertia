import type { GitPreMergeReviewThread } from "../../shared/contracts/git";
import { MAX_PR_FEEDBACK_THREADS } from "../../shared/pr-feedback";
import { GitError } from "./types";

const MAX_COMMENTS = 20;
const MAX_BODY_CHARS = 8_000;
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invalid(): never {
  throw new GitError("operation-failed", "Selected review discussions changed or could not be loaded. Refresh the pull request and try again.");
}

export const REVIEW_DISCUSSIONS_QUERY = `query($ids:[ID!]!){nodes(ids:$ids){... on PullRequestReviewThread{
  id isResolved isOutdated path line
  pullRequest{number url headRefOid updatedAt}
  comments(first:20){nodes{author{login} body url} pageInfo{hasNextPage}}
}}}`;

/** Bind every discussion to the same PR/head as the surrounding readiness read. */
export function parseReviewDiscussions(
  source: string,
  selectedIds: readonly string[],
  expected: { number: number; url: string; head: string; updatedAt: string },
): Map<string, NonNullable<GitPreMergeReviewThread["discussion"]>> {
  if (!selectedIds.length || selectedIds.length > MAX_PR_FEEDBACK_THREADS
    || new Set(selectedIds).size !== selectedIds.length) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { invalid(); }
  if (!record(parsed) || parsed.errors !== undefined && (!Array.isArray(parsed.errors) || parsed.errors.length)
    || !record(parsed.data) || !Array.isArray(parsed.data.nodes)
    || parsed.data.nodes.length !== selectedIds.length) invalid();
  const discussions = new Map<string, NonNullable<GitPreMergeReviewThread["discussion"]>>();
  for (const node of parsed.data.nodes) {
    if (!record(node) || typeof node.id !== "string" || !selectedIds.includes(node.id)
      || discussions.has(node.id) || node.isResolved !== false || !record(node.pullRequest)
      || node.pullRequest.number !== expected.number || node.pullRequest.url !== expected.url
      || node.pullRequest.headRefOid !== expected.head || node.pullRequest.updatedAt !== expected.updatedAt
      || !record(node.comments) || !Array.isArray(node.comments.nodes)
      || node.comments.nodes.length === 0 || node.comments.nodes.length > MAX_COMMENTS
      || !record(node.comments.pageInfo) || typeof node.comments.pageInfo.hasNextPage !== "boolean") invalid();
    let truncated = node.comments.pageInfo.hasNextPage;
    const comments = node.comments.nodes.map((comment) => {
      if (!record(comment) || typeof comment.body !== "string" || !comment.body.trim()
        || typeof comment.url !== "string" || !comment.url.startsWith(`${expected.url}#discussion_`)
        || comment.author !== null && (!record(comment.author) || typeof comment.author.login !== "string")) invalid();
      if (comment.body.length > MAX_BODY_CHARS) truncated = true;
      return {
        author: record(comment.author) ? String(comment.author.login).slice(0, 128) : "Deleted reviewer",
        body: comment.body.slice(0, MAX_BODY_CHARS),
        url: comment.url,
      };
    });
    discussions.set(node.id, { comments, truncated });
  }
  return discussions;
}
