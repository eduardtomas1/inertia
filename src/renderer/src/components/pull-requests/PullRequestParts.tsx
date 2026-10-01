import { CircleCheck, CircleDot, CircleX, Clock3, TriangleAlert, GitMerge, GitPullRequest, GitPullRequestClosed,
  GitPullRequestDraft } from "lucide-react";
import type { LinkedPullRequest, PullRequestSnapshot, StackOperation } from "@shared/pull-requests";

export function pullRequestState(link: LinkedPullRequest): { key: string; label: string } {
  const snapshot = link.snapshot;
  if (!snapshot) return { key: "unknown", label: "Not synced" };
  if (snapshot.draft) return { key: "draft", label: "Draft" };
  return { key: snapshot.state, label: snapshot.state === "merged" ? "Merged" : snapshot.state === "closed" ? "Closed" : "Open" };
}

export function PullRequestIcon({ link }: { link: LinkedPullRequest }): React.JSX.Element {
  const state = pullRequestState(link);
  const Icon = state.key === "merged" ? GitMerge : state.key === "closed" ? GitPullRequestClosed
    : state.key === "draft" ? GitPullRequestDraft : GitPullRequest;
  return <Icon size={16} strokeWidth={1.75} role="img" aria-label={state.label} className={`pr-state-icon is-${state.key}`} />;
}

export function DiffCount({ snapshot }: { snapshot: PullRequestSnapshot }): React.JSX.Element {
  return <span className="pr-diff">
    <span className="pr-additions">+{snapshot.additions}</span>
    <span className="pr-deletions">−{snapshot.deletions}</span>
  </span>;
}

function checksLine(checks: PullRequestSnapshot["checks"]): { tone: string; text: string } {
  const parts = [checks.total ? `${checks.passed} of ${checks.total} checks passing` : "No checks reported"];
  if (checks.failed) parts.push(`${checks.failed} failing`);
  if (checks.pending) parts.push(`${checks.pending} pending`);
  if (!checks.complete) parts.push("Partial");
  const tone = checks.failed ? "danger" : checks.pending || !checks.complete ? "pending"
    : checks.total ? "success" : "muted";
  return { tone, text: parts.join(" · ") };
}

function reviewLine(snapshot: PullRequestSnapshot): { tone: string; text: string } {
  const decision = snapshot.reviewDecision;
  const label = decision === "APPROVED" ? "Approved" : decision === "CHANGES_REQUESTED" ? "Changes requested"
    : decision === "REVIEW_REQUIRED" ? "Review required" : "No review decision";
  const tone = decision === "APPROVED" ? "success" : decision === "CHANGES_REQUESTED" ? "danger"
    : decision === "REVIEW_REQUIRED" ? "pending" : "muted";
  return { tone, text: `${label}${snapshot.unresolvedReviews ? ` · ${snapshot.unresolvedReviews} unresolved` : ""}` };
}

const TONE_ICONS = { success: CircleCheck, danger: CircleX, pending: Clock3, muted: CircleDot } as const;

export function Readiness({ snapshot }: { snapshot: PullRequestSnapshot }): React.JSX.Element {
  return <ul className="pr-readiness" aria-label="Readiness">
    {[checksLine(snapshot.checks), reviewLine(snapshot)].map(({ tone, text }) => {
      const Icon = TONE_ICONS[tone as keyof typeof TONE_ICONS];
      return <li key={text} className={`is-${tone}`}><Icon size={14} strokeWidth={1.75} aria-hidden="true" />{text}</li>;
    })}
  </ul>;
}

function operationView(operation: StackOperation): { tone: string; title: string } {
  const verb = operation.action === "merge" ? "Merge" : "Rebase";
  if (operation.state === "running" || operation.state === "pending") return { tone: "progress", title: `${verb} in progress` };
  if (operation.state === "unknown") return { tone: "warning", title: `${verb} outcome unknown` };
  if (operation.state === "failed") return { tone: "danger", title: `${verb} failed` };
  return { tone: "success", title: `${verb} completed` };
}

const OPERATION_ICONS = { progress: Clock3, warning: TriangleAlert, danger: CircleX, success: CircleCheck } as const;

export function StackActions({ operations }: { operations: StackOperation[] }): React.JSX.Element | null {
  if (!operations.length) return null;
  return <div role="status">
    <ul className="pr-actions" aria-label="Stack actions">
      {operations.map((operation) => {
        const view = operationView(operation);
        const Icon = OPERATION_ICONS[view.tone as keyof typeof OPERATION_ICONS];
        return <li key={operation.id} className={`pr-action is-${view.tone}`} data-state={operation.state}>
          <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
          <div>
            <strong>{view.title}</strong>
            <small>{operation.key.repository} · Stack #{operation.stackNumber}</small>
            <p>{operation.message}</p>
          </div>
        </li>;
      })}
    </ul>
  </div>;
}
