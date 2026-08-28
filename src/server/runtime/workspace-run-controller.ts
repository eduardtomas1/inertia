import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";

import type {
  Conversation,
  ProviderInfo,
  WorkspaceRun,
} from "../../shared/contracts";
import type { RuntimeStore } from "../database";
import { recoverReviewedCommitTransaction } from "../git";
import {
  projectActionCommand,
} from "../runtime-commands";
import {
  publicRuntimeError,
  RuntimeRequestError,
} from "../runtime-errors";
import {
  discoverPackageScripts,
  identifyPreviewScripts,
  WorkspaceError,
} from "../workspace";

const SERVICE_OUTPUT_WINDOW = 4_096;

type WorkspaceRunStore = Pick<
  RuntimeStore,
  | "conversation"
  | "createWorkspaceRun"
  | "updateWorkspaceRun"
  | "conversationWork"
>;

export interface WorkspaceActionTerminalManager<Owner> {
  create(
    owner: Owner,
    cwd: string,
    cols: number,
    rows: number,
    onExit?: (exitCode: number) => void,
    onOutput?: (data: string) => void,
  ): string;
  replace(
    owner: Owner,
    terminalId: string,
    cwd: string,
    cols: number,
    rows: number,
    onExit?: (exitCode: number) => void,
    onOutput?: (data: string) => void,
  ): Promise<string>;
  input(owner: Owner, terminalId: string, data: string): void;
  close(owner: Owner, terminalId: string): Promise<void>;
  closeManaged(terminalId: string): Promise<boolean>;
}

export interface WorkspaceAction {
  id: string;
  label: string;
  command: string;
  preview: boolean;
}

export interface SourceControlSerializationIdentity {
  canonicalPath: string;
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}

export type SourceControlSerializationIdentityResolver = (
  root: string,
) => SourceControlSerializationIdentity;

export type ReviewedCommitRecovery = (
  root: string,
  verifyRepositoryIdentity?: () => void | Promise<void>,
) => Promise<void>;

function sourceControlSerializationIdentity(
  root: string,
): SourceControlSerializationIdentity {
  const canonicalPath = realpathSync.native(root);
  const info = statSync(canonicalPath, { bigint: true });
  if (!info.isDirectory()) throw new Error("Source-control root is not a directory.");
  return {
    canonicalPath,
    dev: info.dev,
    ino: info.ino,
    birthtimeNs: info.birthtimeNs,
  };
}

function sourceControlSerializationKey(
  identity: SourceControlSerializationIdentity,
): string {
  return identity.dev !== 0n && identity.ino !== 0n
    ? `fs:${identity.dev}:${identity.ino}:${identity.birthtimeNs}`
    : `path:${identity.canonicalPath}`;
}

export interface StartWorkspaceActionInput<Owner> {
  owner: Owner;
  cwd: string;
  projectId: string;
  conversationId?: string;
  actionId: string;
  terminalId: string;
  cols: number;
  rows: number;
  /** Called after the process accepted its command and before its first snapshot is published. */
  onStarted: (terminalId: string) => void;
}

export function providerDisplayName(providerId: ProviderInfo["id"]): string {
  return providerId === "codex"
    ? "Codex"
    : providerId === "claude"
      ? "Claude"
      : providerId === "cursor"
        ? "Cursor"
        : providerId === "kimi"
          ? "Kimi Code"
          : "OpenCode";
}

export function workspaceActionKind(
  name: string,
  command: string,
  preview: boolean,
): "check" | "service" {
  const value = `${name} ${command}`.toLowerCase();
  return preview || /(?:^|[:\s-])(dev|serve|server|start|watch|preview)(?:$|[:\s-])/u.test(value)
    ? "service"
    : "check";
}

export function workspaceServicePort(output: string): number | null {
  const plain = output.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "");
  const match = /(?:https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])|\blocalhost)[:/](\d{2,5})/iu.exec(plain);
  const port = Number(match?.[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

function conversationDetail(conversation: Pick<Conversation, "providerId" | "title">): string {
  return `${providerDisplayName(conversation.providerId)} · ${conversation.title}`;
}

/**
 * Owns non-agent workspace run lifecycles. The protocol layer resolves and
 * authorizes workspace paths; this controller owns the durable run record and
 * the exact terminal process associated with an action.
 */
export class WorkspaceRunController<Owner> {
  private readonly managedActions = new Map<string, { terminalId: string }>();
  private readonly sourceControlInFlight = new Map<string, number>();
  private readonly sourceControlTails = new Map<string, Promise<void>>();

  constructor(
    private readonly store: WorkspaceRunStore,
    private readonly terminals: WorkspaceActionTerminalManager<Owner>,
    private readonly broadcastSnapshot: () => void,
    private readonly isClosed: () => boolean,
    private readonly broadcastGitInvalidated: (
      requestId: string,
      projectId: string,
      conversationId: string | null,
    ) => void,
    private readonly resolveSourceControlSerializationIdentity:
      SourceControlSerializationIdentityResolver
      = sourceControlSerializationIdentity,
    private readonly recoverReviewedCommit: ReviewedCommitRecovery
      = recoverReviewedCommitTransaction,
  ) {}

  async listActions(cwd: string): Promise<WorkspaceAction[]> {
    let scripts: Awaited<ReturnType<typeof discoverPackageScripts>>;
    try {
      scripts = await discoverPackageScripts(cwd);
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === "not-found") return [];
      throw error;
    }
    const previews = new Set(identifyPreviewScripts(scripts.scripts).map((script) => script.name));
    return scripts.scripts.slice(0, 50).map((script) => ({
      id: script.name,
      label: script.name,
      command: script.command,
      preview: previews.has(script.name),
    }));
  }

  async startAction(input: StartWorkspaceActionInput<Owner>): Promise<string> {
    const reservationId = `workspace-action:${randomUUID()}`;
    if (!this.store.conversationWork.reserveCheckout(
      reservationId,
      input.projectId,
      input.cwd,
    )) {
      throw new RuntimeRequestError(
        "End the resumed provider terminal before starting project actions in this workspace.",
      );
    }
    let terminalOwnsReservation = false;
    try {
      const scripts = await discoverPackageScripts(input.cwd);
      const action = scripts.scripts.find((script) => script.name === input.actionId);
      if (!action) throw new RuntimeRequestError("That project action is no longer available.");

      const preview = identifyPreviewScripts(scripts.scripts).some((script) => script.name === action.name);
      const kind = workspaceActionKind(action.name, action.command, preview);
      const conversation = input.conversationId
        ? this.store.conversation(input.conversationId)
        : null;
      const activity = this.store.createWorkspaceRun({
        kind,
        projectId: input.projectId,
        conversationId: input.conversationId ?? null,
        actionId: action.name,
        label: action.name,
        detail: kind === "service" && conversation
          ? conversationDetail(conversation)
          : action.command,
        status: "running",
        port: null,
      });

      let detectedPort: number | null = null;
      let serviceOutput = "";
      let startingFailed = false;
      let terminalId: string;
      try {
        terminalId = await this.terminals.replace(
          input.owner,
          input.terminalId,
          input.cwd,
          input.cols,
          input.rows,
          (exitCode) => {
            this.store.conversationWork.release(reservationId);
            this.managedActions.delete(activity.id);
            if (startingFailed) return;
            try {
              this.store.updateWorkspaceRun(activity.id, {
                status: exitCode === 0
                  ? "succeeded"
                  : exitCode === 130
                    ? "cancelled"
                    : "failed",
                detail: exitCode === 0
                  ? activity.detail
                  : exitCode === 130
                    ? "Stopped"
                    : `Exited with code ${exitCode}`,
              });
            } catch {
              return; // The project may have been removed while its process was exiting.
            }
            if (!this.isClosed()) this.broadcastSnapshot();
          },
          (output) => {
            if (kind !== "service" || detectedPort !== null) return;
            serviceOutput = `${serviceOutput}${output}`.slice(-SERVICE_OUTPUT_WINDOW);
            const port = workspaceServicePort(serviceOutput);
            if (!port) return;
            detectedPort = port;
            try {
              this.store.updateWorkspaceRun(activity.id, { port });
            } catch {
              return;
            }
            if (!this.isClosed()) this.broadcastSnapshot();
          },
        );
        terminalOwnsReservation = true;
      } catch (error) {
        this.store.updateWorkspaceRun(activity.id, {
          status: "failed",
          detail: publicRuntimeError(error),
        });
        this.broadcastSnapshot();
        throw error;
      }
      this.managedActions.set(activity.id, { terminalId });

      try {
        this.terminals.input(
          input.owner,
          terminalId,
          `${projectActionCommand(scripts.packageManager, action.name)}\r`,
        );
        input.onStarted(terminalId);
      } catch (error) {
        startingFailed = true;
        try {
          await this.terminals.close(input.owner, terminalId);
        } catch {
          this.managedActions.delete(activity.id);
          terminalOwnsReservation = false;
        }
        this.store.updateWorkspaceRun(activity.id, {
          status: "failed",
          detail: publicRuntimeError(error),
        });
        this.broadcastSnapshot();
        throw error;
      }

      this.broadcastSnapshot();
      return terminalId;
    } finally {
      if (!terminalOwnsReservation) {
        this.store.conversationWork.release(reservationId);
      }
    }
  }

  canStopManagedAction(run: WorkspaceRun): boolean {
    return (
      (run.status === "running" || run.status === "waiting")
      && (run.kind === "check" || run.kind === "service")
      && this.managedActions.has(run.id)
    );
  }

  async stopManagedAction(runId: string): Promise<boolean> {
    const managed = this.managedActions.get(runId);
    return managed !== undefined
      && await this.terminals.closeManaged(managed.terminalId);
  }

  async trackSourceControl<T>(
    label: string,
    projectId: string,
    conversationId: string | undefined,
    checkoutRoot: string,
    requestId: string,
    operation: () => Promise<T>,
    options: {
      recoverReviewedCommit?: boolean;
      serializationRoot?: string;
      verifyRepositoryIdentity?: () => void | Promise<void>;
    } = {},
  ): Promise<T> {
    // Multiple projects may point at different folders in one Git checkout.
    // Reserve each project's checkout scope independently, but serialize every
    // mutation sharing the repository root so only one recovery-journal
    // publisher can own a Git index at a time.
    const serializationRoot = options.serializationRoot ?? checkoutRoot;
    return await this.withExclusiveSourceControl(serializationRoot, async () => {
      const reservationId = `source-control:${requestId}`;
      if (!this.store.conversationWork.reserveCheckout(
        reservationId,
        projectId,
        checkoutRoot,
      )) {
        throw new RuntimeRequestError(
          "End the resumed provider terminal before changing this workspace with Git.",
        );
      }
      try {
        if (options.recoverReviewedCommit) {
          if (!options.verifyRepositoryIdentity) {
            throw new RuntimeRequestError(
              "The repository identity could not be verified before recovery.",
            );
          }
          await options.verifyRepositoryIdentity();
          await this.recoverReviewedCommit(
            serializationRoot,
            options.verifyRepositoryIdentity,
          );
        }
        const invalidationScope = `${projectId}:${conversationId ?? ""}`;
        const detail = conversationId
          ? conversationDetail(this.store.conversation(conversationId))
          : "Started from the workspace";
        const activity = this.store.createWorkspaceRun({
          kind: "source-control",
          projectId,
          conversationId: conversationId ?? null,
          label,
          detail,
          status: "running",
          port: null,
        });
        this.sourceControlInFlight.set(
          invalidationScope,
          (this.sourceControlInFlight.get(invalidationScope) ?? 0) + 1,
        );
        try {
          this.broadcastSnapshot();
        } catch {
          // A live projection failure must not prevent the authoritative Git operation.
        }
        const outcome = await Promise.resolve().then(operation).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        try {
          this.store.updateWorkspaceRun(activity.id, outcome.ok
            ? { status: "succeeded" }
            : {
                status: "failed",
                detail: publicRuntimeError(outcome.error),
              });
        } catch {
          // The Git result is authoritative even if activity persistence is unavailable.
        }
        try {
          this.broadcastSnapshot();
        } catch {
          // A later snapshot or invalidation can repair this best-effort projection.
        }
        const remaining = (this.sourceControlInFlight.get(invalidationScope) ?? 1) - 1;
        if (remaining > 0) {
          this.sourceControlInFlight.set(invalidationScope, remaining);
        } else {
          this.sourceControlInFlight.delete(invalidationScope);
          try {
            this.broadcastGitInvalidated(
              requestId,
              projectId,
              conversationId ?? null,
            );
          } catch {
            // The completed request still truthfully acknowledges the Git result.
          }
        }
        if (!outcome.ok) throw outcome.error;
        return outcome.value;
      } finally {
        try {
          this.store.conversationWork.release(reservationId);
        } catch {
          // Never erase an authoritative operation result during reservation cleanup.
        }
      }
    });
  }

  private async withExclusiveSourceControl<T>(
    serializationRoot: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    let key: string;
    try {
      key = sourceControlSerializationKey(
        this.resolveSourceControlSerializationIdentity(serializationRoot),
      );
    } catch {
      throw new RuntimeRequestError(
        "The workspace is unavailable for this Git operation.",
      );
    }
    const predecessor = this.sourceControlTails.get(key)
      ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.catch(() => undefined).then(async () => {
      await current;
    });
    this.sourceControlTails.set(key, tail);
    await predecessor.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.sourceControlTails.get(key) === tail) {
        this.sourceControlTails.delete(key);
      }
    }
  }
}
