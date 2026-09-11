import { randomUUID } from "node:crypto";
import type { RuntimeStore } from "../database";
import type { CommandIncidents } from "./command-incidents";
import { automaticPull, automaticPullCandidate } from "../git/automatic-pull";
import { isGitProcessTreeTerminationFailure } from "../git/types";
import type { WorkspaceRunController } from "./workspace-run-controller";
import { pinWorktreeSourceIdentity, verifyWorktreeSourceIdentity } from "./worktree-source-identity";

const AUTO_PULL_INTERVAL_MS = 5 * 60_000;
const AUTO_PULL_DEADLINE_MS = 30_000;

interface Dependencies {
  store: RuntimeStore;
  workspaceRuns: Pick<WorkspaceRunController<never>, "trackSourceControl">;
  signal: AbortSignal;
  idle(): boolean;
  track(operation: () => Promise<void>): Promise<void>;
  reportIncident: CommandIncidents["report"];
  cleanupFailed?: () => void;
}

/** One bounded background job at a time; opt-in projects rotate without per-project timers. */
export function startProjectAutoPull(dependencies: Dependencies): void {
  let lastProjectId: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (dependencies.signal.aborted) return;
    timer = setTimeout(tick, AUTO_PULL_INTERVAL_MS);
    timer.unref();
  };
  const tick = (): void => {
    if (dependencies.signal.aborted) return;
    if (!dependencies.idle()) { schedule(); return; }
    const projects = dependencies.store.shellSnapshot().projects.filter((project) =>
      project.preferences?.autoPull && project.repositoryRoot && project.status === "ready");
    const project = projects[(projects.findIndex(({ id }) => id === lastProjectId) + 1) % projects.length];
    if (!project) { schedule(); return; }
    lastProjectId = project.id;
    void dependencies.track(async () => {
      const controller = new AbortController();
      const cancel = (): void => controller.abort();
      dependencies.signal.addEventListener("abort", cancel, { once: true });
      const deadlineAt = Date.now() + AUTO_PULL_DEADLINE_MS;
      const deadline = setTimeout(cancel, AUTO_PULL_DEADLINE_MS);
      const options = { signal: controller.signal, deadlineAt };
      try {
        const path = dependencies.store.projectPath(project.id);
        const pinned = await pinWorktreeSourceIdentity(path);
        const verify = async (): Promise<boolean> => {
          if (controller.signal.aborted || !dependencies.idle()
            || !dependencies.store.project(project.id).preferences?.autoPull) return false;
          dependencies.store.projectPath(project.id);
          await verifyWorktreeSourceIdentity(path, pinned);
          return true;
        };
        if (!await verify()) return;
        const candidate = await automaticPullCandidate(pinned.root, options);
        if (!candidate) return;
        await dependencies.workspaceRuns.trackSourceControl("Automatic pull", project.id, undefined, pinned.root, randomUUID(),
          async () => { await automaticPull(pinned.root, candidate, options, verify); },
          { exclusiveCheckout: true, cancellation: controller });
      } finally {
        clearTimeout(deadline);
        dependencies.signal.removeEventListener("abort", cancel);
      }
    }).catch((error: unknown) => {
      if (isGitProcessTreeTerminationFailure(error)) dependencies.cleanupFailed?.();
      else if (!dependencies.signal.aborted) dependencies.reportIncident({ code: "git.command-failed", outcome: "unknown", context: { projectId: project.id } });
    }).finally(schedule);
  };
  dependencies.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  schedule();
}
