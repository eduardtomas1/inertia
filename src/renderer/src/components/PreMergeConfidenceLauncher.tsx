import { GitPullRequest } from "lucide-react";
import { useEffect, useState } from "react";

import type { CommandWithoutId } from "../lib/runtimeCommands";
import type { GitForge, ServerEvent } from "@shared/contracts";
import { PreMergeConfidenceDialog } from "./PreMergeConfidenceDialog";
import PullRequestDialog from "./PullRequestDialog";
import { confidenceTitle } from "./RepositoryScopeActions";

interface PreMergeConfidenceLauncherProps {
  projectId: string;
  conversationId?: string;
  repositoryPath: string;
  authorityRef?: string;
  forge?: GitForge;
  initialTitle: string;
  pullRequestBusy: boolean;
  pullRequestDisabled: boolean;
  pullRequestDetail?: string;
  run: (key: string, command: CommandWithoutId) => Promise<ServerEvent>;
  buttons?: boolean;
  openRequest?: { kind: "confidence" | "pull-request"; id: number } | null;
}

export function PreMergeConfidenceLauncher({
  projectId,
  conversationId,
  repositoryPath,
  authorityRef,
  forge,
  initialTitle,
  pullRequestBusy,
  pullRequestDisabled,
  pullRequestDetail,
  run,
  buttons = true,
  openRequest = null,
}: PreMergeConfidenceLauncherProps): React.JSX.Element {
  const [open, setOpen] = useState<
    | { kind: "confidence" }
    | { kind: "pull-request"; authorityRef: string }
    | null
  >(null);
  const confidenceEnabled = Boolean(authorityRef) && forge === "github";
  const [handledRequest, setHandledRequest] = useState(openRequest?.id ?? 0);
  useEffect(() => {
    if (!openRequest || openRequest.id === handledRequest) return;
    setHandledRequest(openRequest.id);
    if (openRequest.kind === "confidence" && confidenceEnabled) setOpen({ kind: "confidence" });
    if (openRequest.kind === "pull-request" && authorityRef && !pullRequestDisabled) {
      setOpen({ kind: "pull-request", authorityRef });
    }
  }, [authorityRef, confidenceEnabled, handledRequest, openRequest, pullRequestDisabled]);
  return <>
    {buttons && <>
      <button
        type="button"
        disabled={!confidenceEnabled}
        title={confidenceTitle(authorityRef, forge)}
        onClick={() => {
          if (authorityRef) setOpen({ kind: "confidence" });
        }}
      >
        <GitPullRequest size={14} aria-hidden="true" /><span>Confidence</span>
      </button>
      <button
        type="button"
        disabled={!authorityRef || pullRequestDisabled}
        title={!authorityRef ? "Refresh this repository before changing it." : pullRequestDetail}
        onClick={() => {
          if (authorityRef) setOpen({ kind: "pull-request", authorityRef });
        }}
      >
        <GitPullRequest size={14} aria-hidden="true" /><span>PR</span>
      </button>
    </>}
    {open?.kind === "confidence" && authorityRef && (
      <PreMergeConfidenceDialog
        open
        projectId={projectId}
        conversationId={conversationId}
        repositoryPath={repositoryPath}
        authorityRef={authorityRef}
        run={run}
        onClose={() => setOpen(null)}
      />
    )}
    {open?.kind === "pull-request" && (
      <PullRequestDialog
        open
        initialTitle={initialTitle}
        busy={pullRequestBusy}
        projectId={projectId}
        conversationId={conversationId}
        repositoryPath={repositoryPath}
        authorityRef={open.authorityRef}
        forge={forge}
        run={run}
        onClose={() => setOpen(null)}
      />
    )}
  </>;
}
