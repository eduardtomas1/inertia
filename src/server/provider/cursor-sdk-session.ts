import type { AgentOptions, LocalAgentStore, Run, RunResult, SDKAgent, SDKMessage, SDKCustomTool, ToolName } from "@cursor/sdk";

export interface CursorSdkAuthority {
  conversationId: string;
  turnId: string;
  runId: string;
  providerInstanceId: string;
  workspace: string;
}

export interface CursorSdkSessionDependencies {
  create(options: AgentOptions): Promise<SDKAgent>;
  resume(id: string, options: Partial<AgentOptions>): Promise<SDKAgent>;
  store: LocalAgentStore;
  assertAuthority(authority: Readonly<CursorSdkAuthority>): void;
  emit(message: SDKMessage): Promise<void>;
  model?: string;
  tools?: ToolName[];
  customTools?(sessionId: () => string | undefined): Record<string, SDKCustomTool>;
}

const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 32 * 1024 * 1024;

function boundedText(text: string): void {
  if (!text.trim() || Buffer.byteLength(text) > MAX_MESSAGE_BYTES) throw new Error("Cursor SDK input exceeds its limit.");
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

  async execute(apiKey: string, prompt: string, sessionId?: string): Promise<RunResult> {
    if (this.active || this.closed) throw new Error("Cursor SDK session is unavailable.");
    boundedText(prompt);
    if (!apiKey.trim() || Buffer.byteLength(apiKey) > 16_384) throw new Error("Cursor SDK credential is invalid.");
    this.check();
    this.active = true;
    try {
      const { store } = this.dependencies;
      if (sessionId) {
        const source = await store.agents.get({ agentId: sessionId });
        this.check();
        if (!source || source.agentId !== sessionId || source.cwd !== this.authority.workspace
          || source.activeRunId || source.status !== "idle") throw new Error("Cursor SDK session cannot be resumed.");
      }
      const options: AgentOptions = {
        apiKey,
        tools: this.dependencies.tools ?? [],
        ...(this.dependencies.model ? { model: { id: this.dependencies.model } } : {}),
        local: { cwd: this.authority.workspace, store, settingSources: [], enableAgentRetries: false,
          ...(this.dependencies.customTools ? { customTools: this.dependencies.customTools(() => this.agent?.agentId) } : {}) },
      };
      this.agent = sessionId ? await this.dependencies.resume(sessionId, options) : await this.dependencies.create(options);
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
    this.check();
    if (!this.active || !this.run?.steer || this.steering) throw new Error("Cursor SDK steering is unavailable.");
    this.steering = true;
    try {
      const result = await this.run.steer(text);
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
