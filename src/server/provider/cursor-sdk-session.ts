import type { AgentOptions, LocalAgentStore, Run, RunResult, SDKAgent, SDKMessage, SDKCustomTool, ToolName } from "@cursor/sdk";
import type { CursorSdkStartResult } from "../../node/cursor-sdk-protocol";

export interface CursorSdkAuthority {
  conversationId: string;
  turnId: string;
  runId: string;
  providerInstanceId: string;
  workspace: string;
}

export interface CursorSdkSessionDependencies {
  create(options: AgentOptions): Promise<SDKAgent>;
  /** `storeWorkspace`: the checkout whose store holds the agent, when it is not the session's workspace. */
  resume(id: string, options: Partial<AgentOptions>, storeWorkspace?: string): Promise<SDKAgent>;
  store: LocalAgentStore;
  /**
   * The checkout the resumed agent was created in, when the chat moved to `authority.workspace` with it.
   * `store` is that checkout's store; the agent runs in `authority.workspace`.
   */
  storeWorkspace?: string;
  assertAuthority(authority: Readonly<CursorSdkAuthority>): void;
  emit(message: SDKMessage): Promise<void>;
  model?: string;
  tools?: ToolName[];
  customTools?(sessionId: () => string | undefined): Record<string, SDKCustomTool>;
}

/**
 * Resumes an agent. Cursor keys custom-store lookups by `local.cwd`, so an agent created in another
 * checkout is found only through a platform scoped to that checkout; `local.cwd` still sets where it runs
 * (T3 a18a458f2, `CursorAgentSdk.ts`).
 */
export async function resumeCursorSdkAgent(sdk: Pick<typeof import("@cursor/sdk"), "Agent" | "createAgentPlatform">,
  id: string, options: Partial<AgentOptions>, storeWorkspace?: string): Promise<SDKAgent> {
  if (storeWorkspace === undefined || storeWorkspace === options.local?.cwd) return await sdk.Agent.resume(id, options);
  const localStore = options.local?.store;
  if (!localStore) throw new Error("Cursor SDK moved resume requires its store.");
  const platform = await sdk.createAgentPlatform({ localStore, workspaceRef: storeWorkspace });
  return await platform.resumeAgent(id, options);
}

export class CursorSteerRefusedError extends Error {
  constructor(message = "Cursor SDK steering is unavailable.") {
    super(message);
    this.name = "CursorSteerRefusedError";
  }
}

export function isCursorSdkCleanSteerRefusal(error: unknown): boolean {
  if (error instanceof CursorSteerRefusedError) return true;
  if (!(error instanceof Error)) return false;
  return /^(?:No active session\.|Cursor SDK steering (?:is unavailable|was refused)\.|Cursor SDK authority is no longer active\.)$/u.test(
    error.message,
  ) || /\b(?:not steerable|cannot steer|steer(?:ing)? (?:is )?(?:unavailable|refused|not supported|not active)|no active (?:run|session))\b/iu.test(
    error.message,
  );
}

const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 32 * 1024 * 1024;

function boundedText(text: string): void {
  if (!text.trim() || Buffer.byteLength(text) > MAX_MESSAGE_BYTES) throw new Error("Cursor SDK input exceeds its limit.");
}

/**
 * Runs the session's turn, then closes its store before asking whether Cursor saved a checkpoint for the run
 * (`CursorSdkStoreRecords.runCheckpointed`). This runs in the worker child, off the runtime's event loop. The store's
 * tables mirror its journal (a record joins them only once its append committed) and a closed store refuses every
 * later write, an SDK checkpoint still in flight after a Stop included, so the answer is what the next resume loads.
 * A turn that failed without verified terminal evidence is answered `unverified` with its checkpoint answer, or
 * rethrown when no native run exists or the store cannot tell.
 */
export async function executeCursorSdkRun(session: Pick<CursorSdkSession, "nativeSessionId" | "nativeRun">,
  store: { dispose(): Promise<void>; runCheckpointed(agentId: string, runId: string): boolean | undefined },
  execute: () => Promise<RunResult>): Promise<CursorSdkStartResult> {
  let result: RunResult | undefined;
  let failure: unknown;
  try { result = await execute(); } catch (error) { failure = error; }
  await store.dispose();
  const run = session.nativeRun;
  const runCheckpointed = run ? store.runCheckpointed(run.agentId, run.runId) : undefined;
  if (result === undefined) {
    if (!run || runCheckpointed === undefined) throw failure;
    return { unverified: true, agentId: run.agentId, id: run.runId, runCheckpointed };
  }
  return { ...result, agentId: session.nativeSessionId!,
    ...(runCheckpointed !== undefined && run?.runId === result.id ? { runCheckpointed } : {}) } as CursorSdkStartResult;
}

export class CursorSdkSession {
  private agent: SDKAgent | undefined;
  private run: Run | undefined;
  private active = false;
  private closed = false;
  private cancelling = false;
  private steering = false;
  private cancellation: Promise<void> | undefined;
  readonly authority: Readonly<CursorSdkAuthority>;

  constructor(authority: CursorSdkAuthority, private readonly dependencies: CursorSdkSessionDependencies) {
    if (Object.values(authority).some((value) => !value || value.includes("\0") || value.length > 4096)) {
      throw new Error("Cursor SDK authority is invalid.");
    }
    this.authority = Object.freeze({ ...authority });
  }

  get nativeSessionId(): string | undefined { return this.agent?.agentId; }

  /** The native run Cursor started for the prompt, once `send` returned one of this session's agent. */
  get nativeRun(): { agentId: string; runId: string } | undefined {
    const agentId = this.agent?.agentId;
    return this.run?.id && agentId && this.run.agentId === agentId ? { agentId, runId: this.run.id } : undefined;
  }

  async execute(apiKey: string, prompt: string, sessionId?: string): Promise<RunResult> {
    if (this.active || this.closed) throw new Error("Cursor SDK session is unavailable.");
    boundedText(prompt);
    if (!apiKey.trim() || Buffer.byteLength(apiKey) > 16_384) throw new Error("Cursor SDK credential is invalid.");
    this.check();
    const { storeWorkspace } = this.dependencies;
    if (storeWorkspace !== undefined && (!sessionId || storeWorkspace === this.authority.workspace)) {
      throw new Error("Cursor SDK store workspace is invalid.");
    }
    this.active = true;
    try {
      const { store } = this.dependencies;
      if (sessionId) {
        const source = await store.agents.get({ agentId: sessionId });
        this.check();
        // The agent must be one this store recorded for its own checkout: the session's, or the one it moved from.
        if (!source || source.agentId !== sessionId || source.cwd !== (storeWorkspace ?? this.authority.workspace)
          || source.activeRunId || source.status !== "idle") throw new Error("Cursor SDK session cannot be resumed.");
      }
      const options: AgentOptions = {
        apiKey,
        tools: this.dependencies.tools ?? [],
        ...(this.dependencies.model ? { model: { id: this.dependencies.model } } : {}),
        local: { cwd: this.authority.workspace, store, settingSources: [], enableAgentRetries: false,
          ...(this.dependencies.customTools ? { customTools: this.dependencies.customTools(() => this.agent?.agentId) } : {}) },
      };
      this.agent = sessionId ? await this.dependencies.resume(sessionId, options, storeWorkspace) : await this.dependencies.create(options);
      this.check();
      if (!this.agent.agentId || (sessionId && this.agent.agentId !== sessionId)) throw new Error("Cursor SDK session identity changed.");
      this.run = await this.agent.send(prompt);
      if (this.cancelling) await this.cancelRun();
      this.check();
      const run = this.run;
      if (!run.id || run.agentId !== this.agent.agentId) throw new Error("Cursor SDK run identity changed.");
      let totalBytes = 0;
      for await (const message of run.stream()) {
        this.check();
        if (!message || message.agent_id !== run.agentId || message.run_id !== run.id) throw new Error("Cursor SDK event identity changed.");
        const bytes = Buffer.byteLength(JSON.stringify(message));
        totalBytes += bytes;
        if (bytes > MAX_MESSAGE_BYTES || totalBytes > MAX_STREAM_BYTES) throw new Error("Cursor SDK output exceeds its limit.");
        await this.dependencies.emit(message);
      }
      const result = await run.wait();
      this.check();
      if (result.id !== run.id || !["finished", "error", "cancelled"].includes(result.status)) throw new Error("Cursor SDK terminal identity changed.");
      const persisted = await store.runs.get({ agentId: run.agentId, runId: run.id });
      this.check();
      if (!persisted || persisted.agentId !== run.agentId || persisted.runId !== run.id || persisted.status !== result.status) {
        throw new Error("Cursor SDK terminal state was not persisted.");
      }
      return result;
    } catch {
      await this.cancelRun();
      throw new Error("Cursor SDK execution could not be verified.");
    } finally {
      this.active = false;
      this.closed = true;
      this.agent?.close();
    }
  }

  async steer(text: string): Promise<"complete_delivered" | "revert_to_followup"> {
    boundedText(text);
    this.dependencies.assertAuthority(this.authority);
    if (this.closed || this.cancelling || !this.active || !this.run?.steer || this.steering) {
      return "revert_to_followup";
    }
    this.steering = true;
    try {
      let result: unknown;
      try {
        result = await this.run.steer(text);
      } catch (error) {
        if (isCursorSdkCleanSteerRefusal(error)) return "revert_to_followup";
        throw error;
      }
      this.check();
      if (result !== "complete_delivered" && result !== "revert_to_followup") throw new Error("Cursor SDK steering acknowledgement is invalid.");
      return result;
    } finally { this.steering = false; }
  }

  async cancel(): Promise<void> {
    this.cancelling = true;
    await this.cancelRun();
  }

  private cancelRun(): Promise<void> {
    if (!this.run) return Promise.resolve();
    this.cancellation ??= Promise.resolve().then(() => this.run!.cancel());
    return this.cancellation;
  }

  private check(): void {
    this.dependencies.assertAuthority(this.authority);
    if (this.closed || this.cancelling) throw new Error("Cursor SDK authority is no longer active.");
  }
}
