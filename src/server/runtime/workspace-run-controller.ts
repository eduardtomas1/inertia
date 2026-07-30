import type {
  Conversation,
  ProviderInfo,
  WorkspaceRun,
} from "../../shared/contracts";
import type { RuntimeStore } from "../database";
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
  "conversation" | "createWorkspaceRun" | "updateWorkspaceRun"
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
  input(owner: Owner, terminalId: string, data: string): void;
  close(owner: Owner, terminalId: string): void;
  closeManaged(terminalId: string): Promise<boolean>;
}

export interface WorkspaceAction {
  id: string;
  label: string;
  command: string;
  preview: boolean;
}

export interface StartWorkspaceActionInput<Owner> {
  owner: Owner;
  cwd: string;
  projectId: string;
  conversationId?: string;
  actionId: string;
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

  constructor(
    private readonly store: WorkspaceRunStore,
    private readonly terminals: WorkspaceActionTerminalManager<Owner>,
    private readonly broadcastSnapshot: () => void,
    private readonly isClosed: () => boolean,
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
      terminalId = this.terminals.create(
        input.owner,
        input.cwd,
        input.cols,
        input.rows,
        (exitCode) => {
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
        this.terminals.close(input.owner, terminalId);
      } catch {
        this.managedActions.delete(activity.id);
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
    operation: () => Promise<T>,
  ): Promise<T> {
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
    this.broadcastSnapshot();
    try {
      const result = await operation();
      this.store.updateWorkspaceRun(activity.id, { status: "succeeded" });
      this.broadcastSnapshot();
      return result;
    } catch (error) {
      this.store.updateWorkspaceRun(activity.id, {
        status: "failed",
        detail: publicRuntimeError(error),
      });
      this.broadcastSnapshot();
      throw error;
    }
  }
}
