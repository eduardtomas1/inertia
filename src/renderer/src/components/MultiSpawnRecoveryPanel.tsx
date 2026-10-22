import { useState } from "react";
import type {
  DuoComparisonStatus,
  DuoDispatchState,
  DuoLaunchStatus,
} from "@shared/contracts";
import { writeClipboardText } from "../utils/clipboard";
import type { IdentifiedDuoRecoveryGuidance } from "../utils/multiSpawn";
import {
  formatDuoRecoveryCommand,
  recoveryCommandShell,
} from "../utils/duoRecoveryCommands";
import { duoSideLetter } from "../utils/duoLaunchStatus";

type StatusTone = "done" | "active" | "warning" | "danger" | "muted";

const DISPATCH_LABELS: Record<DuoDispatchState, [string, StatusTone]> = {
  pending: ["Not started", "muted"],
  claimed: ["Starting…", "active"],
  started: ["Started", "done"],
  failed: ["Didn't start", "danger"],
  cancelled: ["Cancelled", "muted"],
  uncertain: ["Unknown — check the chat", "warning"],
};

function launchHeading(status: DuoLaunchStatus): string {
  if (status.state === "recovery-required") return "This duo needs attention";
  if (status.state === "interrupted") return "Dispatch was interrupted";
  if (
    status.sides.some(({ dispatchState }) => dispatchState === "started")
    && status.sides.some(({ dispatchState }) => dispatchState === "failed")
  ) return "One chat didn't start";
  if (
    status.comparison?.state === "failed"
    || status.comparison?.state === "interrupted"
  ) return "The judge didn't finish";
  if (status.state === "dispatching") return "Starting both chats…";
  if (status.state === "running") return "A duo is still running";
  if (status.state === "failed") return "Duo failed";
  if (status.state === "cancelled") return "Duo cancelled";
  return "Preparing…";
}

function comparisonValue(
  comparison: DuoComparisonStatus,
): [string, StatusTone, "muted" | "danger" | null] {
  switch (comparison.state) {
    case "waiting":
      return comparison.error
        ? ["Waiting for its folder", "warning", "muted"]
        : ["Waiting for both chats to finish", "muted", null];
    case "dispatching":
      return ["Starting…", "active", null];
    case "running":
      return ["Comparing…", "active", null];
    case "completed":
      return ["Done", "done", null];
    case "cancelled":
      return ["Cancelled", "muted", null];
    case "failed":
      return ["Didn't finish", "danger", "danger"];
    case "interrupted":
      return ["Interrupted — result unknown", "warning", "muted"];
  }
}

export function MultiSpawnRecoveryPanel({
  recoveryStatus,
  recoveryGuidance,
  busy,
  recheckingRecovery,
  acknowledgingRecovery,
  retryingComparison,
  cancellingComparison,
  onRecheckRecovery,
  onAcknowledgeRecovery,
  onRetryComparison,
  onCancelComparison,
  onOpenJudge,
}: {
  recoveryStatus: DuoLaunchStatus | null;
  recoveryGuidance: IdentifiedDuoRecoveryGuidance[];
  busy: boolean;
  recheckingRecovery: boolean;
  acknowledgingRecovery: boolean;
  retryingComparison: boolean;
  cancellingComparison: boolean;
  onRecheckRecovery?: () => Promise<void>;
  onAcknowledgeRecovery?: () => Promise<void>;
  onRetryComparison?: () => Promise<void>;
  onCancelComparison?: () => Promise<void>;
  onOpenJudge?: (conversationId: string) => void;
}): React.JSX.Element {
  const [copiedRecoveryCommand, setCopiedRecoveryCommand] = useState<
    string | null
  >(null);
  const copyRecoveryCommand = async (
    key: string,
    commandText: string,
  ): Promise<void> => {
    try {
      setCopiedRecoveryCommand(await writeClipboardText(commandText) ? key : null);
    } catch {
      setCopiedRecoveryCommand(null);
    }
  };
  const comparison = recoveryStatus?.comparison ?? null;
  const judgeValue = comparison ? comparisonValue(comparison) : null;
  const canRetry = Boolean(onRetryComparison)
    && (comparison?.state === "failed" || comparison?.state === "interrupted");
  const canAcknowledge = Boolean(onAcknowledgeRecovery)
    && recoveryStatus?.state === "interrupted";
  const canCancel = Boolean(onCancelComparison)
    && comparison !== null
    && comparison.state !== "completed"
    && comparison.state !== "cancelled";

  return (
    <>
      {recoveryStatus && (
        <section
          className="multi-spawn-recovery-status"
          aria-label="Duo status"
        >
          <strong>{launchHeading(recoveryStatus)}</strong>
          {recoveryStatus.state === "interrupted" && (
            <p>
              One provider may have started before the other failed. Check
              both chats before continuing.
            </p>
          )}
          <div className="multi-spawn-status-rows">
            {recoveryStatus.sides.map((side) => {
              const [label, tone] = DISPATCH_LABELS[side.dispatchState];
              return (
                <div
                  key={side.ordinal}
                  className="multi-spawn-status-row"
                  data-tone={tone}
                >
                  <span>{duoSideLetter(side.ordinal)}</span>
                  <span>{label}</span>
                </div>
              );
            })}
          </div>
          {comparison && judgeValue && (
            <section
              className="multi-spawn-comparison-status"
              aria-label="Judge status"
            >
              <h3>Judge</h3>
              <div className="multi-spawn-status-row" data-tone={judgeValue[1]}>
                <span>State</span>
                <span>
                  {judgeValue[0]}
                  {comparison.attempt > 1 && (
                    <span className="multi-spawn-status-attempt">
                      {` · attempt ${comparison.attempt}`}
                    </span>
                  )}
                </span>
                {judgeValue[2] && comparison.error && (
                  <span
                    className={`multi-spawn-status-detail${judgeValue[2] === "danger" ? " is-danger" : ""}`}
                  >
                    {comparison.error}
                  </span>
                )}
                {comparison.conversationId && onOpenJudge
                  ? (
                    <button
                      type="button"
                      className="text-button multi-spawn-status-link"
                      disabled={busy}
                      onClick={() => {
                        if (comparison.conversationId) {
                          onOpenJudge(comparison.conversationId);
                        }
                      }}
                    >
                      {comparison.state === "completed" ? "Open verdict" : "Open judge"}
                    </button>
                  )
                  : !comparison.conversationId && (
                    <span className="multi-spawn-status-detail">
                      The judge hasn't started yet
                    </span>
                  )}
              </div>
            </section>
          )}
          <div className="multi-spawn-recovery-actions">
            {canRetry && (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => { void onRetryComparison?.(); }}
              >
                {retryingComparison ? "Retrying…" : "Retry judge"}
              </button>
            )}
            {canAcknowledge && (
              <button
                type="button"
                className="secondary-button"
                disabled={busy || recheckingRecovery}
                onClick={() => { void onAcknowledgeRecovery?.(); }}
              >
                {acknowledgingRecovery ? "Continuing…" : "Continue"}
              </button>
            )}
            {canCancel && (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => { void onCancelComparison?.(); }}
              >
                {cancellingComparison ? "Cancelling…" : "Cancel judge"}
              </button>
            )}
            {onRecheckRecovery && (
              <button
                type="button"
                className="secondary-button"
                disabled={busy || recheckingRecovery}
                onClick={() => { void onRecheckRecovery(); }}
              >
                {recheckingRecovery ? "Checking…" : "Check again"}
              </button>
            )}
          </div>
        </section>
      )}
      {recoveryGuidance.map((guidance) => (
        <section
          key={`${guidance.launchId}:${guidance.ordinal}:${guidance.worktreeId ?? "unknown"}`}
          className="multi-spawn-recovery-guidance"
          aria-label={`Git worktree details for chat ${duoSideLetter(guidance.ordinal)}`}
        >
          <details className="multi-spawn-lock-contract">
            <summary>Git worktree details · Chat {duoSideLetter(guidance.ordinal)}</summary>
            <p>
              Check this worktree before changing anything. Commands are shown
              only when the layout is unambiguous.
            </p>
            <dl>
              <dt>Repository</dt>
              <dd><code>{guidance.repositoryPath}</code></dd>
              <dt>Planned path</dt>
              <dd><code>{guidance.plannedPath}</code></dd>
              <dt>Registered path</dt>
              <dd><code>{guidance.observedPath ?? "Not verified"}</code></dd>
              <dt>Worktree ID</dt>
              <dd><code>{guidance.worktreeId ?? "Not verified"}</code></dd>
              <dt>Topology</dt>
              <dd><code>{guidance.topology}</code></dd>
              <dt>Generated branch</dt>
              <dd><code>{guidance.generatedBranch}</code></dd>
              <dt>Expected commit</dt>
              <dd><code>{guidance.expectedHead ?? "Not verified"}</code></dd>
              <dt>Observed branch</dt>
              <dd><code>{guidance.observedBranch ?? "Not verified"}</code></dd>
              <dt>Observed commit</dt>
              <dd><code>{guidance.observedHead ?? "Not verified"}</code></dd>
            </dl>
            {guidance.actions.length > 0 && (
              <ol>
                {guidance.actions.map((action) => {
                  const key = `${action.label}:${action.args.join("\0")}`;
                  const shell = recoveryCommandShell(action);
                  const commandText = formatDuoRecoveryCommand(action, shell);
                  return (
                    <li key={key}>
                      <strong>{action.label}</strong>
                      <span>{shell === "powershell" ? "PowerShell" : "POSIX shell"}</span>
                      <code data-recovery-command>{commandText}</code>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => {
                          void copyRecoveryCommand(key, commandText);
                        }}
                      >
                        {copiedRecoveryCommand === key
                          ? "Copied"
                          : `Copy ${action.label.toLocaleLowerCase("en-US")} command`}
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
          </details>
        </section>
      ))}
    </>
  );
}
