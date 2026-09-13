import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";

import type {
  Conversation,
  ProviderInfo,
  WorkspaceRun,
} from "../../shared/contracts";
import type { RuntimeStore } from "../database";
import { executableCandidates, providerEnvironment } from "../environment";
import { gitProcessEnvironment } from "../git/environment";
import { providerProcessInvocation, providerPtyArguments } from "../provider/process";
import type { TerminalManager } from "../terminal";
import { recoverReviewedCommitTransaction } from "../git";
import { GitError, isGitProcessTreeTerminationFailure } from "../git/types";
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
  | "project"
>;

export interface WorkspaceActionTerminalManager<Owner> {
  replaceProcess?: (owner: Owner, ...args: Tail<Parameters<TerminalManager["replaceProcess"]>>) => Promise<string>;
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
    replacementRequestId?: string,
    managedAction?: boolean,
  ): Promise<string>;
  input(owner: Owner, terminalId: string, data: string): void;
  close(owner: Owner, terminalId: string): Promise<void>;
  closeManaged(terminalId: string): Promise<boolean>;
}

type Tail<T extends unknown[]> = T extends [unknown, ...infer Rest] ? Rest : never;

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
  replacementRequestId?: string;
}

export function providerDisplayName(providerId: ProviderInfo["id"]): string {
  return providerId === "codex"
    ? "Codex"
    : providerId === "claude"
      ? "Claude"
      : providerId === "cursor"
        ? "Cursor"
        : providerId === "gemini"
          ? "Gemini"
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
  private readonly cancellableSourceControl = new Map<string, {
    controller: AbortController;
    settled: Promise<unknown>;
  }>();

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

  async listActions(cwd: string, projectId?: string): Promise<WorkspaceAction[]> {
    const custom = projectId ? this.store.project(projectId).preferences?.actions ?? [] : [];
    const configured = custom.map((action) => ({
      id: `custom:${action.id}`, label: action.name,
      command: [action.executable, ...action.args].map((arg) => JSON.stringify(arg)).join(" "),
      preview: false,
    }));
    let scripts: Awaited<ReturnType<typeof discoverPackageScripts>>;
    try {
      scripts = await discoverPackageScripts(cwd);
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === "not-found") return configured;
      throw error;
    }
    const previews = new Set(identifyPreviewScripts(scripts.scripts).map((script) => script.name));
    return [...configured, ...scripts.scripts.slice(0, 50).map((script) => ({
      id: script.name,
      label: script.name,
      command: script.command,
      preview: previews.has(script.name),
    }))];
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
      const custom = input.actionId.startsWith("custom:")
        ? this.store.project(input.projectId).preferences?.actions.find(({ id }) => `custom:${id}` === input.actionId)
        : undefined;
      if (input.actionId.startsWith("custom:") && !custom) {
        throw new RuntimeRequestError("That project action is no longer available.");
      }
      const scripts = custom ? null : await discoverPackageScripts(input.cwd);
      const action = custom ? { name: custom.name, command: custom.executable }
        : scripts?.scripts.find((script) => script.name === input.actionId);
      if (!action) throw new RuntimeRequestError("That project action is no longer available.");

      const preview = scripts ? identifyPreviewScripts(scripts.scripts).some((script) => script.name === action.name) : false;
      const kind = workspaceActionKind(action.name, action.command, preview);
      const conversation = input.conversationId
        ? this.store.conversation(input.conversationId)
        : null;
      const activity = this.store.createWorkspaceRun({
        kind,
        projectId: input.projectId,
        conversationId: input.conversationId ?? null,
        actionId: input.actionId,
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
      let exited = false;
      let terminalId: string;
      try {
        const onExit = (exitCode: number): void => {
            exited = true;
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
          };
        const onOutput = (output: string): void => {
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
          };
        if (custom) {
          if (!this.terminals.replaceProcess) throw new RuntimeRequestError("Direct project actions are unavailable.");
          const discoveredEnvironment = await providerEnvironment();
          const environment = gitProcessEnvironment(discoveredEnvironment.env);
          const [executable] = await executableCandidates(custom.executable, discoveredEnvironment, input.cwd);
          if (!executable) throw new RuntimeRequestError("The project action executable was not found. Check its path in Project settings.");
          const invocation = providerProcessInvocation(executable, custom.args, environment);
          terminalId = await this.terminals.replaceProcess(
            input.owner, input.terminalId, input.cwd, invocation.command, providerPtyArguments(invocation),
            environment, input.cols, input.rows, onExit, onOutput,
            null, false, input.replacementRequestId, undefined, true,
          );
        } else {
          terminalId = await this.terminals.replace(
            input.owner, input.terminalId, input.cwd, input.cols, input.rows,
            onExit, onOutput, input.replacementRequestId, true,
          );
        }
        terminalOwnsReservation = !exited;
      } catch (error) {
        this.store.updateWorkspaceRun(activity.id, {
          status: "failed",
          detail: publicRuntimeError(error),
        });
        this.broadcastSnapshot();
        throw error;
      }
      if (!exited) this.managedActions.set(activity.id, { terminalId });

      try {
        if (scripts) this.terminals.input(
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
      && ((run.kind === "source-control" && this.cancellableSourceControl.has(run.id))
        || ((run.kind === "check" || run.kind === "service") && this.managedActions.has(run.id)))
    );
  }

  async stopManagedAction(runId: string): Promise<boolean> {
    const sourceControl = this.cancellableSourceControl.get(runId);
    if (sourceControl) {
      sourceControl.controller.abort();
      const failure = await sourceControl.settled;
      if (isGitProcessTreeTerminationFailure(failure)) throw failure;
      return true;
    }
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
      onMutationStarting?: () => void;
      onMutationSettled?: () => void;
      /** Only operations with independently bounded cancellation may opt in. */
      cancellation?: AbortController;
      exclusiveCheckout?: boolean;
    } = {},
  ): Promise<T> {
    // Multiple projects may point at different folders in one Git checkout.
    // Reserve each project's checkout scope independently, but serialize every
    // mutation sharing the repository root so only one recovery-journal
    // publisher can own a Git index at a time.
    const serializationRoot = options.serializationRoot ?? checkoutRoot;
    return await this.withExclusiveSourceControl(serializationRoot, async () => {
      const reservationId = `source-control:${requestId}`;
      const reserve = options.exclusiveCheckout
        ? this.store.conversationWork.reserveExclusiveCheckout.bind(this.store.conversationWork)
        : this.store.conversationWork.reserveCheckout.bind(this.store.conversationWork);
      if (!reserve(
        reservationId,
        projectId,
        checkoutRoot,
      )) {
        throw new RuntimeRequestError(
          options.exclusiveCheckout ? "Stop active work before changing this workspace with Git."
            : "End the resumed provider terminal before changing this workspace with Git.",
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
        let settleCancellation: ((failure: unknown) => void) | undefined;
        if (options.cancellation) {
          this.cancellableSourceControl.set(activity.id, {
            controller: options.cancellation,
            settled: new Promise((resolve) => { settleCancellation = resolve; }),
          });
        }
        this.sourceControlInFlight.set(
          invalidationScope,
          (this.sourceControlInFlight.get(invalidationScope) ?? 0) + 1,
        );
        try {
          this.broadcastSnapshot();
        } catch {
          // A live projection failure must not prevent the authoritative Git operation.
        }
        try {
          options.onMutationStarting?.();
        } catch {
          // Scan invalidation is best effort; mutation authority is unchanged.
        }
        const outcome = await Promise.resolve().then(operation).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        try {
          options.onMutationSettled?.();
        } catch {
          // The authoritative Git outcome must survive projection invalidation.
        }
        try {
          this.store.updateWorkspaceRun(activity.id, outcome.ok
            ? { status: "succeeded" }
            : {
                status: options.cancellation?.signal.aborted && outcome.error instanceof GitError && outcome.error.code === "timeout"
                  ? "cancelled" : "failed",
                detail: publicRuntimeError(outcome.error),
              });
        } catch {
          // The Git result is authoritative even if activity persistence is unavailable.
        }
        this.cancellableSourceControl.delete(activity.id);
        settleCancellation?.(outcome.ok ? null : outcome.error);
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
