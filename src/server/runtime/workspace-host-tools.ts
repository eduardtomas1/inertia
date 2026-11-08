import { realpath } from "node:fs/promises";

import { z } from "zod";

import type { AgentGoal, AgentTurn, Conversation } from "../../shared/contracts";
import type { RuntimeStore } from "../database";
import { getRepositoryStatus, GitError } from "../git";
import { repositoryMetadataMarkerIdentity, repositoryRoot } from "../git/paths";
import type {
  ProviderHostToolCall,
  ProviderHostToolDefinition,
  ProviderHostToolResult,
} from "../provider/contracts";
import { RecordNotFoundError } from "../persistence/errors";
import {
  HOST_TOOL_GIT_READ_TIMEOUT_MS,
  TurnGitArtifactError,
  type TurnGitArtifactManager,
} from "../turn-git-artifacts";
import { sourceControlStatusScan } from "./commands/source-control-scan-coordination";
import { invalidHostToolArguments } from "./host-tool-argument-errors";
import type { WorkspaceRunController } from "./workspace-run-controller";
import {
  jsonBytes,
  workspaceCommand,
  workspaceLabel,
  workspaceText,
  type WorkspaceTextScope,
} from "./workspace-host-tool-text";
import {
  MAX_WORKSPACE_RESULT_BYTES,
  TurnDiffCursorError,
  turnDiffPage,
} from "./workspace-turn-diff-pages";

export const WORKSPACE_GIT_STATUS_TOOL_NAME = "inertia_git_status";
export const WORKSPACE_TURN_DIFF_TOOL_NAME = "inertia_turn_diff";
export const WORKSPACE_READ_PLAN_TOOL_NAME = "inertia_read_plan";
export const WORKSPACE_READ_GOAL_TOOL_NAME = "inertia_read_goal";
export const WORKSPACE_LIST_TASKS_TOOL_NAME = "inertia_list_tasks";
export const WORKSPACE_PROJECT_ACTIONS_TOOL_NAME = "inertia_project_actions";

export const MAX_GIT_STATUS_FILES = 200;
export const MAX_PLAN_DOCUMENT_BYTES = 16 * 1024;
export const MAX_PLAN_STEP_BYTES = 300;
export const MAX_TASKS = 200;
export const MAX_TASK_NOTE_BYTES = 1_024;
export const MAX_GOAL_OBJECTIVE_BYTES = 4 * 1024;
const MAX_PATH_BYTES = 1_024;
const MAX_LABEL_BYTES = 256;
const MAX_TASK_TITLE_BYTES = 600;
const MAX_ACTION_COMMAND_BYTES = 1_024;
const MAX_ACTIONS = 60;
/** How long a diff read waits for a turn that has just settled to finish its capture. */
export const SETTLING_TURN_DIFF_WAIT_MS = 5_000;

const noArguments = z.object({}).strict();
const singleLine = (maximum: number) => z.string()
  .min(1)
  .max(maximum)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "Use one line without control characters");
const turnDiffSchema = z.object({
  turnId: singleLine(200).optional(),
  cursor: singleLine(512).optional(),
}).strict();
const listTasksSchema = z.object({ includeDone: z.boolean().optional() }).strict();

const EMPTY_SCHEMA = { type: "object", additionalProperties: false, properties: {} } as const;

function definition(
  name: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  inputValidator: z.ZodType<Record<string, unknown>>,
): ProviderHostToolDefinition {
  return {
    name,
    description,
    inputSchema,
    inputValidator,
    readOnly: true,
    destructive: false,
  };
}

export const WORKSPACE_TOOL_DEFINITIONS: readonly ProviderHostToolDefinition[] = [
  definition(
    WORKSPACE_GIT_STATUS_TOOL_NAME,
    `Read this chat's Git status as the Changes view shows it: whether the workspace is a repository, the branch, its upstream, ahead and behind counts, and up to ${MAX_GIT_STATUS_FILES} changed files with their status, staged and unstaged state, and whether the user marked them reviewed.`,
    EMPTY_SCHEMA,
    noArguments,
  ),
  definition(
    WORKSPACE_TURN_DIFF_TOOL_NAME,
    "Read the unified diff of this chat's current turn so far, or of an earlier turn with turnId. Pages by file, up to 24 KiB of diff each: pass nextCursor back as cursor with the same turnId. restarted: true means the running turn's file list changed and paging began again. Binary files are named only.",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        turnId: { type: "string", minLength: 1, maxLength: 200, description: "A turn of this chat; defaults to the current turn." },
        cursor: { type: "string", minLength: 1, maxLength: 512, description: "nextCursor from the previous result for the same turn." },
      },
    },
    turnDiffSchema,
  ),
  definition(
    WORKSPACE_READ_PLAN_TOOL_NAME,
    `Read this chat's latest plan as the Plan tab shows it: whether the provider reported one, its steps with their status, and the plan document as markdown (at most ${MAX_PLAN_DOCUMENT_BYTES / 1024} KiB).`,
    EMPTY_SCHEMA,
    noArguments,
  ),
  definition(
    WORKSPACE_READ_GOAL_TOOL_NAME,
    "Read this chat's current goal: whether it is a Codex native goal or an Inertia local objective, its objective, status, token budget and usage, and time used. Returns goal null when the chat has none.",
    EMPTY_SCHEMA,
    noArguments,
  ),
  definition(
    WORKSPACE_LIST_TASKS_TOOL_NAME,
    `List the user's Inertia tasks for this project, newest first: tasks assigned to this project, and tasks with no project that are unlinked or linked to a chat in this project, at most ${MAX_TASKS}, each note cut to 1 KiB. Done tasks are left out unless includeDone is true.`,
    {
      type: "object",
      additionalProperties: false,
      properties: { includeDone: { type: "boolean", description: "Include completed tasks." } },
    },
    listTasksSchema,
  ),
  definition(
    WORKSPACE_PROJECT_ACTIONS_TOOL_NAME,
    "List the project's Run actions for this chat's workspace (configured actions and package scripts) with their command and whether each is running, with its local preview URL when one was detected. This tool cannot start or stop an action.",
    EMPTY_SCHEMA,
    noArguments,
  ),
];

export const WORKSPACE_TOOL_NAMES: ReadonlySet<string> = new Set(
  WORKSPACE_TOOL_DEFINITIONS.map(({ name }) => name),
);

export interface WorkspaceHostToolDependencies {
  store: Pick<
    RuntimeStore,
    | "agentGoals"
    | "agentTurn"
    | "conversation"
    | "conversationPath"
    | "todos"
    | "turnGitArtifact"
    | "workspaceToolReads"
  >;
  turnGitArtifacts?: Pick<TurnGitArtifactManager, "turnDiff" | "liveTurnDiff">
    & Partial<Pick<TurnGitArtifactManager, "settledTurnDiffWithin">>;
  workspaceRuns?: Pick<WorkspaceRunController<never>, "listActions">;
}

export interface WorkspaceToolSource {
  /** The chat as `assertSource` just re-read it. */
  conversation: Conversation;
  turn: AgentTurn;
}

class WorkspaceToolFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const unavailable = (message: string) => new WorkspaceToolFailure("workspace_unavailable", message);
const TURN_NOT_FOUND = "No turn with that id belongs to this chat.";

function json(value: unknown): ProviderHostToolResult {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > MAX_WORKSPACE_RESULT_BYTES) {
    throw new WorkspaceToolFailure("host_tool_failed", "The result exceeded its size limit.");
  }
  return { success: true, text };
}

function failure(code: string, message: string): ProviderHostToolResult {
  return { success: false, text: JSON.stringify({ error: { code, message } }) };
}

function invalidArguments(tool: string, args: unknown, error: z.ZodError): ProviderHostToolResult {
  const schema = WORKSPACE_TOOL_DEFINITIONS.find(({ name }) => name === tool)?.inputSchema;
  return failure("invalid_arguments", invalidHostToolArguments(tool, schema, args, error));
}

/**
 * Configured actions arrive as JSON-quoted argv. Unquote plain arguments so
 * the command scrubber sees `--token value` the way a shell would.
 */
function plainCommand(action: { id: string; command: string }): string {
  if (!action.id.startsWith("custom:")) return action.command;
  const quoted = action.command.match(/"(?:[^"\\]|\\.)*"/gu) ?? [];
  try {
    return quoted.map((part) => JSON.parse(part) as string)
      // Quote only arguments a shell would split, and never escape backslashes:
      // a doubled Windows separator would hide the path from the redactor.
      .map((argument) => /^[^\s"']+$/u.test(argument) ? argument : `"${argument.replaceAll("\"", "\\\"")}"`)
      .join(" ");
  } catch {
    return action.command;
  }
}

/** Adds items while the encoded result stays under the host-tool cap. */
function fitted<T>(
  items: readonly T[],
  maximum: number,
  build: (included: T[], truncated: boolean) => unknown,
): unknown {
  const included: T[] = [];
  for (const item of items.slice(0, maximum)) {
    if (jsonBytes(build([...included, item], true)) > MAX_WORKSPACE_RESULT_BYTES) break;
    included.push(item);
  }
  return build(included, included.length < items.length);
}

/** Read-only `inertia.workspace` tools: the chat's Git, turn diffs, plan, goal, tasks, and Run actions. */
export class WorkspaceHostTools {
  constructor(private readonly dependencies: WorkspaceHostToolDependencies) {}

  async invoke(source: WorkspaceToolSource, call: ProviderHostToolCall): Promise<ProviderHostToolResult> {
    if (call.signal.aborted) return failure("call_cancelled", "The host tool call was cancelled.");
    try {
      const result = await this.dispatch(source, call);
      if (call.signal.aborted) return failure("call_cancelled", "The host tool call was cancelled.");
      return result;
    } catch (error) {
      if (call.signal.aborted) return failure("call_cancelled", "The host tool call was cancelled.");
      if (error instanceof WorkspaceToolFailure) return failure(error.code, error.message);
      if (error instanceof TurnDiffCursorError) return failure("invalid_arguments", error.message);
      if (error instanceof TurnGitArtifactError) return failure("host_tool_failed", error.message);
      if (error instanceof GitError) {
        return failure("host_tool_failed", error.code === "timeout"
          ? "Git did not answer in time."
          : "Git could not read this repository.");
      }
      return failure("host_tool_failed", "The Inertia workspace tool failed.");
    }
  }

  private async dispatch(source: WorkspaceToolSource, call: ProviderHostToolCall): Promise<ProviderHostToolResult> {
    const args = call.arguments ?? {};
    switch (call.tool) {
      case WORKSPACE_GIT_STATUS_TOOL_NAME: {
        const parsed = noArguments.safeParse(args);
        return parsed.success ? await this.gitStatus(source, call.signal) : invalidArguments(call.tool, args, parsed.error);
      }
      case WORKSPACE_TURN_DIFF_TOOL_NAME: {
        const parsed = turnDiffSchema.safeParse(args);
        return parsed.success ? await this.turnDiff(source, parsed.data, call.signal) : invalidArguments(call.tool, args, parsed.error);
      }
      case WORKSPACE_READ_PLAN_TOOL_NAME: {
        const parsed = noArguments.safeParse(args);
        return parsed.success ? await this.readPlan(source) : invalidArguments(call.tool, args, parsed.error);
      }
      case WORKSPACE_READ_GOAL_TOOL_NAME: {
        const parsed = noArguments.safeParse(args);
        return parsed.success ? await this.readGoal(source) : invalidArguments(call.tool, args, parsed.error);
      }
      case WORKSPACE_LIST_TASKS_TOOL_NAME: {
        const parsed = listTasksSchema.safeParse(args);
        return parsed.success ? await this.listTasks(source, parsed.data.includeDone === true) : invalidArguments(call.tool, args, parsed.error);
      }
      case WORKSPACE_PROJECT_ACTIONS_TOOL_NAME: {
        const parsed = noArguments.safeParse(args);
        return parsed.success ? await this.projectActions(source) : invalidArguments(call.tool, args, parsed.error);
      }
      default:
        return failure("unknown_tool", "That Inertia host tool is not available.");
    }
  }

  /** The chat's own workspace folder, or `workspace_unavailable` without leaking its path. */
  private async workspace(conversation: Conversation): Promise<{ path: string; scope: WorkspaceTextScope }> {
    let path: string;
    try {
      path = this.dependencies.store.conversationPath(conversation.id);
    } catch {
      throw unavailable("This chat has no workspace folder Inertia can read.");
    }
    const canonical = await realpath(path).catch(() => null);
    if (!canonical) throw unavailable("This chat's workspace folder is missing.");
    return { path, scope: { roots: [path, canonical] } };
  }

  private async gitStatus(source: WorkspaceToolSource, signal: AbortSignal): Promise<ProviderHostToolResult> {
    const { conversation } = source;
    const workspace = await this.workspace(conversation);
    // One deadline for every Git read, under the provider's host-tool timeout.
    const deadlineAt = Date.now() + HOST_TOOL_GIT_READ_TIMEOUT_MS;
    const options = { deadlineAt, signal };
    let root: string;
    try {
      root = await repositoryRoot(workspace.path, options);
    } catch (error) {
      if (error instanceof GitError && error.code === "not-repository") {
        return json({ repository: false, branch: null, upstream: null, ahead: 0, behind: 0, files: [], totalFiles: 0, truncated: false });
      }
      if (error instanceof GitError && error.code === "not-found") throw unavailable("This chat's workspace folder is missing.");
      throw error;
    }
    const marker = await repositoryMetadataMarkerIdentity(root, options);
    const status = await getRepositoryStatus(root, {
      deadlineAt,
      signal,
      scan: sourceControlStatusScan(conversation.projectId, conversation.id, workspace.path, root, marker, "status"),
    });
    if (await repositoryMetadataMarkerIdentity(root, options) !== marker) {
      throw new WorkspaceToolFailure("host_tool_failed", "The Git repository changed while it was being read. Try again.");
    }
    const scope = { roots: [...workspace.scope.roots, root] };
    const reviews = this.dependencies.store.workspaceToolReads.fileReviewStates(conversation.id);
    const files = status.files.map((file) => {
      const review = reviews.get(file.path);
      return {
        path: workspaceLabel(file.path, MAX_PATH_BYTES, scope),
        ...(file.previousPath ? { previousPath: workspaceLabel(file.previousPath, MAX_PATH_BYTES, scope) } : {}),
        status: file.status,
        staged: file.staged,
        unstaged: file.unstaged,
        reviewed: review !== undefined && review.reviewed && !review.stale,
      };
    });
    return json(fitted(files, MAX_GIT_STATUS_FILES, (included, cut) => ({
      repository: true,
      branch: status.branch === null ? null : workspaceLabel(status.branch, MAX_LABEL_BYTES, scope),
      detached: status.detached,
      upstream: status.upstream === null ? null : workspaceLabel(status.upstream, MAX_LABEL_BYTES, scope),
      ahead: status.ahead,
      behind: status.behind,
      files: included,
      totalFiles: status.files.length,
      truncated: cut || status.truncated,
    })));
  }

  private async turnDiff(
    source: WorkspaceToolSource,
    input: z.infer<typeof turnDiffSchema>,
    signal: AbortSignal,
  ): Promise<ProviderHostToolResult> {
    const { conversation } = source;
    let turn: AgentTurn;
    try {
      turn = input.turnId === undefined || input.turnId === source.turn.id
        ? source.turn
        : this.dependencies.store.agentTurn(input.turnId);
    } catch (error) {
      if (error instanceof RecordNotFoundError) throw new WorkspaceToolFailure("turn_not_found", TURN_NOT_FOUND);
      throw error;
    }
    if (turn.conversationId !== conversation.id) throw new WorkspaceToolFailure("turn_not_found", TURN_NOT_FOUND);
    const artifacts = this.dependencies.turnGitArtifacts;
    if (!artifacts) throw unavailable("Turn diffs are not available in this runtime.");
    const workspace = await this.workspace(conversation);
    const artifact = this.dependencies.store.turnGitArtifact(turn.id);
    if (artifact?.absenceReason === "not-repository") {
      throw unavailable("This chat's workspace is not a Git repository, so its turns have no diff.");
    }
    const page = (details: Omit<Parameters<typeof turnDiffPage>[0], "turnId" | "cursor" | "scope">) =>
      json(turnDiffPage({ ...details, turnId: turn.id, cursor: input.cursor, scope: workspace.scope }));
    // The active turn's artifact stays pending until it settles, so its diff
    // so far is compared live against the turn's starting snapshot.
    if (turn.id === source.turn.id && (!artifact || artifact.status === "pending")) {
      const live = await artifacts.liveTurnDiff(turn.id, { signal });
      return page({
        state: "live",
        files: live.files,
        patch: live.patch,
        patchNote: live.patchTruncated ? "The diff reached its size limit; later files may be missing." : null,
        captureTruncated: live.truncated,
      });
    }
    if (!artifact) throw new WorkspaceToolFailure("host_tool_failed", "This turn has no recorded repository changes.");
    let settled = artifact;
    let patch: string | null = null;
    let patchNote: string | null = null;
    let patchRead = false;
    if (settled.status === "pending") {
      // A turn that has just ended is still capturing its changes. Wait a
      // little for that capture, within this call's own cancellation.
      try {
        const snapshot = await artifacts.settledTurnDiffWithin?.(turn.id, {
          signal,
          timeoutMs: SETTLING_TURN_DIFF_WAIT_MS,
        });
        if (snapshot) {
          patch = snapshot.patch;
          patchRead = true;
        }
      } catch (error) {
        if (!(error instanceof TurnGitArtifactError)) throw error;
      }
      settled = this.dependencies.store.turnGitArtifact(turn.id) ?? settled;
      if (settled.status === "pending") {
        throw new WorkspaceToolFailure("host_tool_failed", "This turn's changes are still being captured. Try again shortly.");
      }
    }
    if (!patchRead) {
      try {
        patch = (await artifacts.turnDiff(turn.id)).patch;
      } catch (error) {
        if (!(error instanceof TurnGitArtifactError)) throw error;
        patchNote = error.message;
      }
    }
    return page({
      state: "settled",
      files: settled.files,
      patch,
      patchNote,
      captureTruncated: settled.completeness !== "complete",
    });
  }

  private async readPlan(source: WorkspaceToolSource): Promise<ProviderHostToolResult> {
    const { conversation } = source;
    const plans = this.dependencies.store.workspaceToolReads.latestPlans(conversation.id);
    const newest = plans.at(-1);
    if (!newest) {
      return json({ plan: { source: "none", turnId: null, steps: [], document: null, documentTruncated: false } });
    }
    const scope = await this.workspace(conversation).then(({ scope: value }) => value, () => ({ roots: [] }));
    const documented = newest.explanation?.trim()
      ? newest.explanation
      : newest.turnId
        ? plans.slice(0, -1).reverse().find(({ explanation }) => explanation?.trim())?.explanation ?? null
        : null;
    const steps = newest.steps.map((step) => ({
      step: workspaceText(step.step, MAX_PLAN_STEP_BYTES, scope).text,
      status: step.status,
    }));
    let budget = MAX_PLAN_DOCUMENT_BYTES;
    for (;;) {
      const document = documented === null ? null : workspaceText(documented, Math.max(0, budget), scope);
      const value = {
        plan: {
          source: "native",
          turnId: newest.turnId,
          steps,
          document: document?.text ?? null,
          documentTruncated: document?.truncated ?? false,
        },
      };
      const overflow = jsonBytes(value) - MAX_WORKSPACE_RESULT_BYTES;
      if (overflow <= 0 || budget <= 0) return json(value);
      budget -= overflow + 64;
    }
  }

  private async readGoal(source: WorkspaceToolSource): Promise<ProviderHostToolResult> {
    const { conversation } = source;
    const native = conversation.providerId === "codex"
      && conversation.modelSelection.harnessId === "codex-app-server";
    // The same goals the Goal panel shows: local objectives, and the native
    // goal of the chat's current Codex thread.
    const goals = this.dependencies.store.agentGoals(conversation.id).filter((goal) =>
      goal.source === "inertia-local"
      || (conversation.providerSessionId !== null && goal.providerSessionId === conversation.providerSessionId));
    const current: AgentGoal | undefined = goals.find(({ source: goalSource }) =>
      goalSource === (native ? "codex-native" : "inertia-local"))
      ?? [...goals].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt, "en"))[0];
    if (!current) return json({ goal: null });
    const scope = await this.workspace(conversation).then(({ scope: value }) => value, () => ({ roots: [] }));
    const objective = workspaceText(current.objective, MAX_GOAL_OBJECTIVE_BYTES, scope);
    return json({
      goal: {
        source: current.source,
        objective: objective.text,
        objectiveTruncated: objective.truncated,
        status: current.status,
        tokenBudget: current.tokenBudget,
        tokensUsed: current.tokensUsed,
        timeUsedSeconds: current.timeUsedSeconds,
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
      },
    });
  }

  private async listTasks(source: WorkspaceToolSource, includeDone: boolean): Promise<ProviderHostToolResult> {
    const { conversation } = source;
    const { store } = this.dependencies;
    const scope = await this.workspace(conversation).then(({ scope: value }) => value, () => ({ roots: [] }));
    const linked = new Map<string, Conversation | null>();
    const linkedConversation = (id: string): Conversation | null => {
      if (!linked.has(id)) {
        let value: Conversation | null = null;
        try { value = store.conversation(id); } catch { value = null; }
        linked.set(id, value);
      }
      return linked.get(id) ?? null;
    };
    const tasks = store.todos.list()
      .filter((todo) => includeDone || todo.completedAt === null)
      // A task assigned to a project belongs to it. Tasks from before project
      // assignment have none: they belong to the project of their linked chat,
      // and unlinked ones to every project.
      .filter((todo) => todo.projectId === null
        ? todo.conversationId === null
          || linkedConversation(todo.conversationId)?.projectId === conversation.projectId
        : todo.projectId === conversation.projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt, "en") || right.id.localeCompare(left.id, "en"))
      .map((todo) => {
        const note = workspaceText(todo.note, MAX_TASK_NOTE_BYTES, scope);
        const chat = todo.conversationId === null ? null : linkedConversation(todo.conversationId);
        return {
          id: todo.id,
          title: workspaceLabel(todo.title, MAX_TASK_TITLE_BYTES, scope),
          note: note.text,
          noteTruncated: note.truncated,
          priority: todo.priority,
          dueDate: todo.dueDate,
          done: todo.completedAt !== null,
          linkedConversationId: chat?.id ?? null,
          linkedStatus: chat?.status ?? null,
        };
      });
    return json(fitted(tasks, MAX_TASKS, (included, cut) => ({
      tasks: included,
      totalTasks: tasks.length,
      truncated: cut,
    })));
  }

  private async projectActions(source: WorkspaceToolSource): Promise<ProviderHostToolResult> {
    const { conversation } = source;
    const runs = this.dependencies.workspaceRuns;
    if (!runs) throw unavailable("Run actions are not available in this runtime.");
    const workspace = await this.workspace(conversation);
    const actions = await runs.listActions(workspace.path, conversation.projectId);
    const active = this.dependencies.store.workspaceToolReads.activeProjectActionRuns(conversation.projectId);
    const rows = actions.map((action) => {
      const running = active.filter(({ actionId }) => actionId === action.id);
      const here = running.find(({ conversationId }) => conversationId === conversation.id) ?? running[0];
      return {
        id: workspaceLabel(action.id, MAX_LABEL_BYTES, workspace.scope),
        label: workspaceLabel(action.label, MAX_LABEL_BYTES, workspace.scope),
        command: workspaceCommand(plainCommand(action), MAX_ACTION_COMMAND_BYTES, workspace.scope).text,
        preview: action.preview,
        running: running.length > 0,
        runningInThisChat: running.some(({ conversationId }) => conversationId === conversation.id),
        previewUrl: here?.port ? `http://localhost:${here.port}` : null,
      };
    });
    return json(fitted(rows, MAX_ACTIONS, (included, cut) => ({
      actions: included,
      totalActions: rows.length,
      truncated: cut,
    })));
  }
}
