import { randomUUID } from "node:crypto";
import type { RuntimeStore } from "../database";
import { executableCandidates, providerEnvironment } from "../environment";
import { launchCredentialValues, sanitizeProviderFailureDetail } from "../provider/activity-detail";
import { RestrictedCliError, runRestrictedCli } from "../restricted-cli-runner";
import { WORKTREE_SETUP_OUTPUT_LIMIT, WORKTREE_SETUP_TIMEOUT_MS, type WorktreeSetupSummary } from "../../shared/worktree-setup";

interface Dependencies {
  store: RuntimeStore;
  broadcastSnapshot(): void;
  signal: AbortSignal;
  track<T>(operation: () => Promise<T>): Promise<T>;
  cleanupFailed?: (error: Error) => void;
  run?: typeof runRestrictedCli;
}

/** Setup owns the checkout until the entire command process tree has stopped. */
export class WorktreeSetupController {
  private readonly active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private readonly quarantined = new Set<string>();

  constructor(private readonly dependencies: Dependencies) {}

  initialize(conversationId: string): void {
    const { store } = this.dependencies;
    const conversation = store.conversation(conversationId);
    if (!conversation.worktreePath || !store.conversationWorktrees.get(conversationId)?.ownsWorktree) return;
    const preferences = store.project(conversation.projectId).preferences;
    const action = preferences?.actions.find(({ id }) => id === preferences.worktreeSetupActionId);
    if (!action || store.worktreeSetups.read(conversationId)) return;
    store.worktreeSetups.initialize(conversationId, action);
    this.start(conversationId);
  }

  read(conversationId: string): { summary: WorktreeSetupSummary | null; output: string } {
    this.dependencies.store.conversationPath(conversationId);
    const setup = this.dependencies.store.worktreeSetups.forCheckout(conversationId);
    return { summary: setup?.summary ?? null, output: setup?.output ?? "" };
  }

  async wait(conversationId: string): Promise<ReturnType<WorktreeSetupController["read"]>> {
    const id = this.owner(conversationId);
    const task = this.active.get(id)?.done;
    if (task) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([task, new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); })]);
      } finally { if (timer) clearTimeout(timer); }
    }
    return this.read(conversationId);
  }

  async waitUntilReady(conversationId: string): Promise<void> {
    await this.active.get(this.owner(conversationId))?.done;
    this.dependencies.store.worktreeSetups.assertReady(conversationId);
  }

  cancel(conversationId: string): void {
    this.active.get(this.owner(conversationId))?.abort.abort();
  }

  retry(conversationId: string): void {
    const id = this.owner(conversationId);
    if (this.active.has(id) || this.quarantined.has(id)) throw new Error("Setup is still stopping. Wait before retrying.");
    const setup = this.dependencies.store.worktreeSetups.read(id);
    if (!setup || !["failed", "cancelled", "interrupted"].includes(setup.summary.status)) throw new Error("Only unsuccessful setup can be retried.");
    this.start(id);
  }

  skip(conversationId: string): void {
    const id = this.owner(conversationId);
    if (this.active.has(id) || this.quarantined.has(id)) throw new Error("Stop setup and wait for it to finish before continuing.");
    const setup = this.dependencies.store.worktreeSetups.read(id);
    if (!setup || !["failed", "cancelled", "interrupted"].includes(setup.summary.status)) throw new Error("Only unsuccessful setup can be skipped.");
    this.dependencies.store.worktreeSetups.update(id, { ...setup.summary, status: "skipped", detail: "Continuing without setup. The checkout has been kept.", finishedAt: new Date().toISOString() });
    this.dependencies.broadcastSnapshot();
  }

  private owner(conversationId: string): string {
    this.dependencies.store.conversationPath(conversationId);
    return this.dependencies.store.worktreeSetups.forCheckout(conversationId)?.conversationId ?? conversationId;
  }

  private start(conversationId: string): void {
    const abort = new AbortController();
    // Defer execution until the entry exists, including admission failure paths.
    const done = Promise.resolve().then(() => this.dependencies.track(() => this.execute(conversationId, abort.signal)))
      .catch(() => {
        const setup = this.dependencies.store.worktreeSetups.read(conversationId);
        if (setup) this.dependencies.store.worktreeSetups.update(conversationId, { ...setup.summary, status: "interrupted", finishedAt: new Date().toISOString(), detail: "Setup was interrupted. Retry explicitly when the runtime is ready." });
      }).finally(() => {
        this.active.delete(conversationId);
        this.dependencies.broadcastSnapshot();
      });
    this.active.set(conversationId, { abort, done });
    this.dependencies.broadcastSnapshot();
  }

  private async execute(conversationId: string, signal: AbortSignal): Promise<void> {
    const { store } = this.dependencies;
    const setup = store.worktreeSetups.read(conversationId);
    if (!setup) return;
    let summary: WorktreeSetupSummary = { ...setup.summary, status: "running", attempt: setup.summary.attempt + 1, startedAt: new Date().toISOString(), finishedAt: null, detail: "Preparing this checkout. Your first prompt will wait for setup." };
    store.worktreeSetups.update(conversationId, summary, "");
    const reservationId = `worktree-setup:${randomUUID()}`;
    let reserved = false;
    let runId: string | undefined;
    let cleanupConfirmed = true;
    const chunks: Buffer[] = [];
    const combined = AbortSignal.any([signal, this.dependencies.signal]);
    let credentials = launchCredentialValues(process.env);
    let cwd: string | undefined;
    try {
      cwd = store.conversationPath(conversationId);
      const conversation = store.conversation(conversationId);
      if (!conversation.worktreePath || !store.conversationWorktrees.get(conversationId)?.ownsWorktree) throw new Error("The owned worktree is unavailable.");
      reserved = store.conversationWork.reserveExclusiveCheckout(reservationId, conversation.projectId, cwd);
      if (!reserved) throw new Error("The checkout is busy.");
      runId = store.createWorkspaceRun({ projectId: conversation.projectId, conversationId, actionId: setup.action.id, kind: "check", label: `Setup: ${setup.action.name}`, status: "running", detail: "Preparing a new worktree", port: null }).id;
      this.dependencies.broadcastSnapshot();
      const environment = await providerEnvironment();
      credentials = [...credentials, ...launchCredentialValues(environment.env)];
      const [executable] = await executableCandidates(setup.action.executable, environment, cwd);
      if (!executable) throw new RestrictedCliError("unavailable", "Setup executable is unavailable.");
      if (store.conversationPath(conversationId) !== cwd) throw new Error("The checkout identity changed.");
      await (this.dependencies.run ?? runRestrictedCli)(executable, setup.action.args, {
        cwd, environment: environment.env, signal: combined, timeoutMs: WORKTREE_SETUP_TIMEOUT_MS, maxOutputBytes: 1024 * 1024,
        failureMessage: "Setup exited unsuccessfully.", onOutput: (chunk) => { chunks.push(chunk); },
      });
      summary = { ...summary, status: "succeeded", detail: "Worktree ready. Setup completed successfully." };
    } catch (error) {
      cleanupConfirmed = !(error instanceof RestrictedCliError && error.code === "cleanup");
      if (!cleanupConfirmed) {
        this.quarantined.add(conversationId);
        this.dependencies.cleanupFailed?.(error as Error);
      }
      summary = { ...summary, status: combined.aborted ? "cancelled" : "failed", detail: !cleanupConfirmed
        ? "Setup cleanup could not be confirmed. Restart Inertia before retrying or continuing."
        : combined.aborted ? "Setup stopped. Retry or continue without setup. Your checkout has been kept."
        : error instanceof RestrictedCliError && error.code === "unavailable" ? "Setup executable was not found. Check its installation, then retry or continue without setup."
        : error instanceof RestrictedCliError && error.code === "timeout" ? "Setup exceeded 10 minutes. Retry or continue without setup."
        : error instanceof RestrictedCliError && error.code === "output-limit" ? "Setup exceeded the output limit and was stopped. Retry or continue without setup."
        : "Setup failed. Inspect the output, then retry or continue without setup. Your checkout has been kept." };
    } finally {
      summary = { ...summary, finishedAt: new Date().toISOString() };
      const output = sanitizeProviderFailureDetail(Buffer.concat(chunks).toString("utf8"), credentials, { workspaceRoot: cwd, maxChars: WORKTREE_SETUP_OUTPUT_LIMIT }) ?? "";
      store.worktreeSetups.update(conversationId, summary, output);
      if (runId) store.updateWorkspaceRun(runId, { status: summary.status === "succeeded" ? "succeeded" : summary.status === "cancelled" ? "cancelled" : "failed", detail: summary.detail, finishedAt: summary.finishedAt });
      if (reserved && cleanupConfirmed) store.conversationWork.release(reservationId);
    }
  }
}
