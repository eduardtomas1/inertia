import {
  AlertCircle,
  CheckCircle2,
  CircleDot,
  Clock3,
  ExternalLink,
  FileCheck2,
  GitPullRequest,
  MonitorCheck,
  PackageCheck,
  RefreshCw,
  ShieldCheck,
  TestTube2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  GitPreMergeConfidence,
  GitPreMergeEvidenceState,
  ServerEvent,
} from "@shared/contracts";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { resultEvent } from "../lib/runtimeCommands";
import { captureModalFocus, trapModalFocus } from "../utils/modalFocus";
import { IconButton, LoadingMark } from "./ui";

const EVIDENCE_FRESH_MS = 60_000;

export interface PreMergeConfidenceDialogProps {
  open: boolean;
  projectId: string;
  conversationId?: string;
  repositoryPath: string;
  authorityRef: string;
  run: (key: string, command: CommandWithoutId) => Promise<ServerEvent>;
  onClose: () => void;
}

function shortHead(head: string | null): string {
  return head?.slice(0, 8) ?? "unavailable";
}

function evidenceLabel(state: GitPreMergeEvidenceState): string {
  if (state === "passed") return "Passed";
  if (state === "failed") return "Failed";
  if (state === "pending") return "Pending";
  if (state === "skipped") return "Skipped";
  if (state === "cancelled") return "Cancelled";
  if (state === "neutral") return "Neutral";
  if (state === "missing") return "Missing";
  return "Unknown";
}

function StateMark({ state }: { state: GitPreMergeEvidenceState }): React.JSX.Element {
  if (state === "passed") return <CheckCircle2 aria-hidden="true" />;
  if (state === "pending") return <Clock3 aria-hidden="true" />;
  if (state === "missing" || state === "unknown" || state === "neutral") {
    return <CircleDot aria-hidden="true" />;
  }
  return <AlertCircle aria-hidden="true" />;
}

function FactSource({ kind, children }: {
  kind: "local" | "github" | "claim";
  children: React.ReactNode;
}): React.JSX.Element {
  return <span className={`pre-merge-source is-${kind}`}>{children}</span>;
}

function stateSummary(checks: GitPreMergeConfidence["checks"]): string {
  if (checks.length === 0) return "No checks reported";
  const passed = checks.filter(({ state }) => state === "passed").length;
  const pending = checks.filter(({ state }) => state === "pending").length;
  const attention = checks.length - passed - pending;
  return [
    `${passed} passed`,
    pending > 0 ? `${pending} pending` : null,
    attention > 0 ? `${attention} need attention` : null,
  ].filter(Boolean).join(" · ");
}

function headlineFor(
  confidence: GitPreMergeConfidence | null,
  loading: boolean,
  stale: boolean,
): { title: string; detail: string; state: string } {
  if (loading && !confidence) {
    return {
      title: "Loading exact-head evidence",
      detail: "Reading local Git state and authoritative GitHub state.",
      state: "pending",
    };
  }
  if (!confidence) {
    return {
      title: "Evidence unavailable",
      detail: "No pre-merge evidence has been loaded.",
      state: "unknown",
    };
  }
  if (loading || stale) {
    return {
      title: loading ? "Refreshing evidence" : "Refresh required",
      detail: loading
        ? "Green is withheld until the local and GitHub identities are revalidated."
        : "This evidence is older than one minute. Refresh before relying on it.",
      state: "pending",
    };
  }
  if (confidence.state === "no-pull-request") {
    return {
      title: "No open pull request",
      detail: confidence.identity.detail,
      state: "unknown",
    };
  }
  if (confidence.state === "unavailable") {
    return {
      title: "Evidence incomplete",
      detail: confidence.unavailableReason ?? confidence.identity.detail,
      state: "unknown",
    };
  }
  if (confidence.mergeReadiness.state === "ready") {
    return {
      title: "Exact-head green",
      detail: confidence.identity.detail,
      state: "passed",
    };
  }
  if (confidence.mergeReadiness.state === "pending") {
    return {
      title: "Checks in progress",
      detail: "The exact head is identified, but pending evidence is not green.",
      state: "pending",
    };
  }
  return {
    title: "Needs attention",
    detail: "One or more exact-head merge conditions are not satisfied.",
    state: "failed",
  };
}

export function PreMergeConfidenceDialog({
  open,
  projectId,
  conversationId,
  repositoryPath,
  authorityRef,
  run,
  onClose,
}: PreMergeConfidenceDialogProps): React.JSX.Element | null {
  const [confidence, setConfidence] = useState<GitPreMergeConfidence | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const requestRevision = useRef(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  useNativePreviewSuspension(open);

  const load = useCallback(async (): Promise<void> => {
    const revision = ++requestRevision.current;
    setLoading(true);
    setError(null);
    try {
      const event = resultEvent(await run("git.pr.confidence", {
        type: "git.pr.confidence",
        payload: {
          projectId,
          conversationId,
          repositoryPath,
          authorityRef,
        },
      }));
      if (event.result.kind !== "git.pr.confidence") {
        throw new Error("The local service returned unexpected pre-merge evidence.");
      }
      if (revision === requestRevision.current) {
        setConfidence(event.result.confidence);
        setClock(Date.now());
      }
    } catch (reason) {
      if (revision === requestRevision.current) {
        setError(reason instanceof Error
          ? reason.message
          : "Pre-merge evidence could not be loaded.");
      }
    } finally {
      if (revision === requestRevision.current) setLoading(false);
    }
  }, [authorityRef, conversationId, projectId, repositoryPath, run]);

  const openExternal = useCallback(async (url: string): Promise<void> => {
    try {
      await window.inertia.openExternal(url);
    } catch {
      setError("The verified GitHub link could not be opened.");
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setConfidence(null);
    setError(null);
    void load();
    const restoreFocus = captureModalFocus(false);
    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 0);
    const clockTimer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => {
      requestRevision.current += 1;
      window.clearTimeout(focusTimer);
      window.clearInterval(clockTimer);
      restoreFocus();
    };
  }, [load, open]);

  const stale = useMemo(() => {
    if (!confidence) return false;
    const generatedAt = Date.parse(confidence.generatedAt);
    return !Number.isFinite(generatedAt) || clock - generatedAt > EVIDENCE_FRESH_MS;
  }, [clock, confidence]);
  const headline = headlineFor(confidence, loading, stale);
  if (!open) return null;

  const github = confidence?.github ?? null;
  const codexThreads = confidence?.reviewThreads.filter(({ codex }) => codex) ?? [];
  const otherThreads = confidence?.reviewThreads.filter(({ codex }) => !codex) ?? [];
  const visibleFiles = confidence?.files.slice(0, 12) ?? [];
  const remainingFiles = confidence?.files.slice(12) ?? [];
  return (
    <div
      className="dialog-backdrop pre-merge-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="pre-merge-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pre-merge-title"
        aria-describedby="pre-merge-headline-detail"
        data-state={headline.state}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          trapModalFocus(event, event.currentTarget);
        }}
      >
        <header className="pre-merge-header">
          <span className="dialog-icon"><ShieldCheck size={19} /></span>
          <div>
            <span className="pre-merge-kicker">Pre-merge confidence</span>
            <h2 id="pre-merge-title">{headline.title}</h2>
            <p id="pre-merge-headline-detail">{headline.detail}</p>
          </div>
          <span className="pre-merge-header-actions">
            <IconButton
              label="Refresh pre-merge evidence"
              onClick={() => void load()}
              disabled={loading}
            >
              {loading ? <LoadingMark label="Refreshing pre-merge evidence" /> : <RefreshCw size={15} />}
            </IconButton>
            <IconButton ref={closeRef} label="Close pre-merge confidence" onClick={onClose}>
              <X size={16} />
            </IconButton>
          </span>
        </header>

        <div className="pre-merge-scroll">
          <div className="pre-merge-source-legend" aria-label="Evidence sources">
            <FactSource kind="local">Local repository</FactSource>
            <FactSource kind="github">GitHub authoritative</FactSource>
            <FactSource kind="claim">PR author claim</FactSource>
          </div>

          {error && (
            <div className="pre-merge-alert" role="alert">
              <AlertCircle size={15} /><span><strong>Action failed.</strong> {error}</span>
            </div>
          )}

          {!confidence && loading && (
            <div className="pre-merge-loading" role="status">
              <LoadingMark label="Loading local and GitHub evidence" />
              <span>Checking exact identities, reviews, and hosted checks…</span>
            </div>
          )}

          {confidence && (
            <>
              <section className="pre-merge-section pre-merge-identity" aria-labelledby="pre-merge-identity-title">
                <div className="pre-merge-section-heading">
                  <GitPullRequest size={15} />
                  <div><h3 id="pre-merge-identity-title">Exact identity</h3><span>Green applies only to this local head and this GitHub PR head.</span></div>
                  <span className={`pre-merge-state is-${confidence.identity.state}`}>{confidence.identity.state}</span>
                </div>
                <div className="pre-merge-identity-grid">
                  <div>
                    <FactSource kind="local">Local</FactSource>
                    <strong>{confidence.local.branch ?? "Detached head"}</strong>
                    <code title={confidence.local.head ?? undefined}>{shortHead(confidence.local.head)}</code>
                    <small>{confidence.local.dirty ? "Uncommitted local changes" : "Working tree clean"}</small>
                  </div>
                  <div>
                    <FactSource kind="github">GitHub</FactSource>
                    <strong>{github?.headBranch ?? "No open PR"}</strong>
                    <code title={github?.head}>{shortHead(github?.head ?? null)}</code>
                    <small>{github ? `PR #${github.number} → ${github.baseBranch}` : "Remote head unavailable"}</small>
                  </div>
                </div>
                {confidence.local.files.length > 0 && (
                  <details className="pre-merge-details">
                    <summary>{confidence.local.files.length} local {confidence.local.files.length === 1 ? "file" : "files"} outside the PR head</summary>
                    <ul>{confidence.local.files.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
                  </details>
                )}
                {confidence.local.filesTruncated && <p className="pre-merge-caution">Local changed-file evidence is truncated.</p>}
              </section>

              <section className="pre-merge-section" aria-labelledby="pre-merge-checks-title">
                <div className="pre-merge-section-heading">
                  <MonitorCheck size={15} />
                  <div><h3 id="pre-merge-checks-title">Hosted checks</h3><span>{stateSummary(confidence.checks)}</span></div>
                  <FactSource kind="github">GitHub</FactSource>
                </div>
                {confidence.checks.length > 0 ? (
                  <ul className="pre-merge-status-list">
                    {confidence.checks.map((check, index) => (
                      <li data-state={check.state} key={`${check.workflow ?? "status"}:${check.name}:${index}`}>
                        <StateMark state={check.state} />
                        <span><strong>{check.name}</strong>{check.workflow && <small>{check.workflow}</small>}</span>
                        <em>{evidenceLabel(check.state)}</em>
                      </li>
                    ))}
                  </ul>
                ) : <p className="pre-merge-empty">No checks were reported for this head. Missing checks are not green.</p>}
                {confidence.checksTruncated && <p className="pre-merge-caution">More checks exist than this bounded view can show. The result cannot be green.</p>}
              </section>

              <section className="pre-merge-section" aria-labelledby="pre-merge-reviews-title">
                <div className="pre-merge-section-heading">
                  <FileCheck2 size={15} />
                  <div>
                    <h3 id="pre-merge-reviews-title">Actionable review threads</h3>
                    <span>{codexThreads.length} Codex · {otherThreads.length} other unresolved</span>
                  </div>
                  <FactSource kind="github">GitHub</FactSource>
                </div>
                {confidence.reviewThreads.length === 0 ? (
                  <p className="pre-merge-empty">{confidence.state === "ready" ? "No unresolved, current review threads." : "Review-thread cleanliness was not proven."}</p>
                ) : (
                  <ul className="pre-merge-thread-list">
                    {confidence.reviewThreads.map((thread) => (
                      <li key={thread.id}>
                        <div><strong>{thread.codex ? "Codex" : thread.author}</strong><code>{thread.path}{thread.line ? `:${thread.line}` : ""}</code></div>
                        <p>{thread.body}</p>
                        {thread.url && <button type="button" onClick={() => void openExternal(thread.url!)}><ExternalLink size={11} />Open thread</button>}
                      </li>
                    ))}
                  </ul>
                )}
                {confidence.reviewThreadsTruncated && <p className="pre-merge-caution">More than 100 review threads exist; this view is incomplete and cannot be green.</p>}
              </section>

              <section className="pre-merge-section" aria-labelledby="pre-merge-scope-title">
                <div className="pre-merge-section-heading">
                  <FileCheck2 size={15} />
                  <div><h3 id="pre-merge-scope-title">Affected scope</h3><span>{confidence.totalFiles} remote {confidence.totalFiles === 1 ? "file" : "files"}</span></div>
                  <FactSource kind="github">GitHub</FactSource>
                </div>
                <ul className="pre-merge-area-list">
                  {confidence.areas.map((area) => <li key={area.name}><strong>{area.name}</strong><span>{area.files}</span></li>)}
                </ul>
                <ul className="pre-merge-file-list">
                  {visibleFiles.map((file) => <li key={file.path}><code>{file.path}</code><span><b>+{file.insertions}</b><i>−{file.deletions}</i></span></li>)}
                </ul>
                {remainingFiles.length > 0 && (
                  <details className="pre-merge-details">
                    <summary>Show {remainingFiles.length} more loaded files</summary>
                    <ul className="pre-merge-file-list">
                      {remainingFiles.map((file) => <li key={file.path}><code>{file.path}</code><span><b>+{file.insertions}</b><i>−{file.deletions}</i></span></li>)}
                    </ul>
                  </details>
                )}
                {confidence.filesTruncated && <p className="pre-merge-caution">The PR contains more than {confidence.files.length} files. Affected scope is truncated.</p>}
              </section>

              <section className="pre-merge-section pre-merge-evidence" aria-labelledby="pre-merge-evidence-title">
                <div className="pre-merge-section-heading">
                  <TestTube2 size={15} />
                  <div><h3 id="pre-merge-evidence-title">Test and portability evidence</h3><span>Execution evidence stays separate from changed test scope.</span></div>
                </div>
                <div className="pre-merge-evidence-row">
                  <FactSource kind="github">GitHub checks</FactSource>
                  <strong>Focused test evidence</strong>
                  <span>{confidence.focusedTestChecks.length > 0 ? confidence.focusedTestChecks.join(" · ") : "No exact-head focused test checks published"}</span>
                </div>
                <div className="pre-merge-platforms" aria-label="Required platform coverage">
                  {confidence.platforms.map((platform) => (
                    <div data-state={platform.state} key={platform.platform}>
                      <StateMark state={platform.state} />
                      <strong>{platform.platform}</strong>
                      <span>{evidenceLabel(platform.state)}</span>
                      <small>{platform.checks.length > 0 ? platform.checks.join(" · ") : "No matching check"}</small>
                    </div>
                  ))}
                </div>
                <div className="pre-merge-evidence-row">
                  <FactSource kind="github">Changed scope</FactSource>
                  <strong>Changed test files</strong>
                  <span>{confidence.changedTestFiles.length > 0 ? confidence.changedTestFiles.join(" · ") : "None in the loaded PR file set"}</span>
                  <small>Changed test files are scope evidence, not proof that they ran.</small>
                </div>
                <div className="pre-merge-evidence-row">
                  <PackageCheck size={14} aria-hidden="true" />
                  <strong>Bundle delta</strong>
                  <span>{confidence.bundle.summary}</span>
                </div>
              </section>

              <section className="pre-merge-section pre-merge-readiness" aria-labelledby="pre-merge-readiness-title">
                <div className="pre-merge-section-heading">
                  <ShieldCheck size={15} />
                  <div><h3 id="pre-merge-readiness-title">Readiness</h3><span>Merge confidence and release proof are intentionally different.</span></div>
                </div>
                <div className="pre-merge-readiness-row">
                  <strong>Merge</strong><span data-state={confidence.mergeReadiness.state}>{confidence.mergeReadiness.state}</span>
                </div>
                {confidence.mergeReadiness.blockers.length > 0 && (
                  <ul className="pre-merge-blockers">
                    {confidence.mergeReadiness.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
                  </ul>
                )}
                <div className="pre-merge-readiness-row">
                  <strong>Release</strong><span data-state="not-proven">Not proven</span>
                </div>
                <p className="pre-merge-release-detail">{confidence.releaseReadiness.detail}</p>
              </section>

              {confidence.authorClaim && (
                <section className="pre-merge-section" aria-labelledby="pre-merge-claim-title">
                  <div className="pre-merge-section-heading">
                    <FileCheck2 size={15} />
                    <div><h3 id="pre-merge-claim-title">PR description</h3><span>User-entered text is shown as a claim, never as execution evidence.</span></div>
                    <FactSource kind="claim">Author claim</FactSource>
                  </div>
                  <details className="pre-merge-details pre-merge-claim">
                    <summary>View claimed summary and verification</summary>
                    <pre>{confidence.authorClaim.body}</pre>
                    {confidence.authorClaim.truncated && <small>Claim text is truncated.</small>}
                  </details>
                </section>
              )}
            </>
          )}
        </div>

        <footer className="pre-merge-footer">
          <span>{confidence ? `Evidence collected ${new Date(confidence.generatedAt).toLocaleTimeString()}` : "Evidence not yet collected"}{stale ? " · stale" : ""}</span>
          {github && <button type="button" className="secondary-button" onClick={() => void openExternal(github.url)}><ExternalLink size={13} />Open PR #{github.number}</button>}
          <button type="button" className="primary-button" onClick={onClose}>Done</button>
        </footer>
      </section>
    </div>
  );
}

export default PreMergeConfidenceDialog;
