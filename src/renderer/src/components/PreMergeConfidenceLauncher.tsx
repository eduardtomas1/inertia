import { GitPullRequest } from "lucide-react";
import { useState } from "react";

import type { CommandWithoutId } from "../lib/runtimeCommands";
import type { GitForge, ServerEvent } from "@shared/contracts";
import { PreMergeConfidenceDialog } from "./PreMergeConfidenceDialog";
import PullRequestDialog from "./PullRequestDialog";

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
}: PreMergeConfidenceLauncherProps): React.JSX.Element {
  const [open, setOpen] = useState<"confidence" | "pull-request" | null>(null);
  const confidenceEnabled = Boolean(authorityRef) && forge === "github";
  return <>
    <button
      type="button"
      disabled={!confidenceEnabled}
      title={!authorityRef
        ? "Refresh this repository before loading remote evidence."
        : forge !== "github"
          ? "Exact-head confidence is currently available for GitHub repositories."
          : "Compare this local head with authoritative GitHub checks, reviews, and merge state."
      }
      onClick={() => setOpen("confidence")}
    >
      <GitPullRequest size={12} aria-hidden="true" /><span>Confidence</span>
    </button>
    <button
      type="button"
      disabled={!authorityRef || pullRequestDisabled}
      title={!authorityRef ? "Refresh this repository before changing it." : pullRequestDetail}
      onClick={() => setOpen("pull-request")}
    >
      <GitPullRequest size={12} aria-hidden="true" /><span>PR</span>
    </button>
    {open === "confidence" && authorityRef && (
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
    {open === "pull-request" && authorityRef && (
      <PullRequestDialog
        open
        initialTitle={initialTitle}
        busy={pullRequestBusy}
        projectId={projectId}
        conversationId={conversationId}
        repositoryPath={repositoryPath}
        authorityRef={authorityRef}
        forge={forge}
        run={run}
        onClose={() => setOpen(null)}
      />
    )}
  </>;
}
