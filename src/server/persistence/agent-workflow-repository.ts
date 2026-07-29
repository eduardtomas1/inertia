import type { AgentGoal } from "../../shared/contracts";
import { agentGoalFromRow } from "./codecs";
import type { PersistenceContext } from "./context";
import type { AgentGoalRow } from "./rows";

type AgentWorkflowPersistenceContext = Pick<
  PersistenceContext,
  "database" | "requireConversation"
>;

export interface NativeAgentGoalMergeResult {
  goal: AgentGoal | null;
  changed: boolean;
}

interface NativeAgentGoalTombstone {
  providerSessionId: string;
  updatedAt: string;
}

const MAX_NATIVE_GOAL_TOMBSTONES = 1_024;

function nativeGoalRevision(timestamp: string): string {
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) return timestamp;
  return new Date(
    Math.floor(milliseconds / 1_000) * 1_000,
  ).toISOString();
}

function sameNativeGoalPayload(left: AgentGoal, right: AgentGoal): boolean {
  return left.providerSessionId === right.providerSessionId
    && left.objective === right.objective
    && left.status === right.status
    && left.tokenBudget === right.tokenBudget
    && left.tokensUsed === right.tokensUsed
    && left.timeUsedSeconds === right.timeUsedSeconds
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt;
}

export class AgentWorkflowRepository {
  private readonly nativeGoalTombstones =
    new Map<string, NativeAgentGoalTombstone>();

  constructor(private readonly context: AgentWorkflowPersistenceContext) {}

  goals(conversationId: string): AgentGoal[] {
    this.context.requireConversation(conversationId);
    return (this.context.database.prepare(`
      SELECT * FROM agent_goals
      WHERE conversation_id = ?
      ORDER BY source ASC
    `).all(conversationId) as AgentGoalRow[]).map(agentGoalFromRow);
  }

  upsert(goal: AgentGoal): AgentGoal {
    this.context.requireConversation(goal.conversationId);
    this.write(goal);
    return this.goal(goal.conversationId, goal.source)!;
  }

  mergeNative(
    goal: AgentGoal,
    authoritativeMutation = false,
  ): NativeAgentGoalMergeResult {
    this.context.requireConversation(goal.conversationId);
    if (goal.source !== "codex-native" || !goal.providerSessionId) {
      throw new Error("Native goal merge requires a Codex provider session.");
    }
    const existing = this.goal(goal.conversationId, goal.source);
    if (
      existing?.providerSessionId === goal.providerSessionId
      && (
        goal.updatedAt < existing.updatedAt
        || (
          !authoritativeMutation && goal.updatedAt === existing.updatedAt
          && sameNativeGoalPayload(existing, goal)
        )
      )
    ) {
      return { goal: existing, changed: false };
    }
    const tombstone = this.nativeGoalTombstones.get(goal.conversationId);
    if (
      tombstone?.providerSessionId === goal.providerSessionId
      && (
        goal.updatedAt < tombstone.updatedAt
        || (!authoritativeMutation && goal.updatedAt === tombstone.updatedAt)
      )
    ) {
      return { goal: null, changed: false };
    }
    this.write(goal);
    this.nativeGoalTombstones.delete(goal.conversationId);
    return {
      goal: this.goal(goal.conversationId, goal.source)!,
      changed: true,
    };
  }

  private write(goal: AgentGoal): void {
    this.context.database.prepare(`
      INSERT INTO agent_goals (
        conversation_id, source, provider_session_id, objective, status,
        token_budget, tokens_used, time_used_seconds, created_at, updated_at,
        synchronized_at
      ) VALUES (
        @conversationId, @source, @providerSessionId, @objective, @status,
        @tokenBudget, @tokensUsed, @timeUsedSeconds, @createdAt, @updatedAt,
        @synchronizedAt
      )
      ON CONFLICT(conversation_id, source) DO UPDATE SET
        provider_session_id = excluded.provider_session_id,
        objective = excluded.objective,
        status = excluded.status,
        token_budget = excluded.token_budget,
        tokens_used = excluded.tokens_used,
        time_used_seconds = excluded.time_used_seconds,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        synchronized_at = excluded.synchronized_at
    `).run(goal);
  }

  clear(
    conversationId: string,
    source: AgentGoal["source"],
    tombstoneAt?: string,
    providerSessionId?: string,
  ): boolean {
    this.context.requireConversation(conversationId);
    if (source === "codex-native") {
      const existing = this.goal(conversationId, source);
      const tombstoneRevision = tombstoneAt
        ? nativeGoalRevision(tombstoneAt)
        : undefined;
      if (existing?.providerSessionId) {
        this.rememberNativeGoalTombstone({
          conversationId,
          providerSessionId: existing.providerSessionId,
          updatedAt: tombstoneRevision
            && tombstoneRevision > existing.updatedAt
            ? tombstoneRevision
            : existing.updatedAt,
        });
      } else if (tombstoneRevision && providerSessionId) {
        this.rememberNativeGoalTombstone({
          conversationId,
          providerSessionId,
          updatedAt: tombstoneRevision,
        });
      } else if (tombstoneRevision) {
        const previous = this.nativeGoalTombstones.get(conversationId);
        if (previous) {
          this.rememberNativeGoalTombstone({
            conversationId,
            providerSessionId: previous.providerSessionId,
            updatedAt: tombstoneRevision > previous.updatedAt
              ? tombstoneRevision
              : previous.updatedAt,
          });
        }
      }
    }
    return this.context.database.prepare(`
      DELETE FROM agent_goals
      WHERE conversation_id = ? AND source = ?
    `).run(conversationId, source).changes > 0;
  }

  private rememberNativeGoalTombstone(input: {
    conversationId: string;
    providerSessionId: string;
    updatedAt: string;
  }): void {
    const existing = this.nativeGoalTombstones.get(input.conversationId);
    if (
      existing?.providerSessionId === input.providerSessionId
      && existing.updatedAt >= input.updatedAt
    ) return;
    this.nativeGoalTombstones.delete(input.conversationId);
    this.nativeGoalTombstones.set(input.conversationId, {
      providerSessionId: input.providerSessionId,
      updatedAt: input.updatedAt,
    });
    while (this.nativeGoalTombstones.size > MAX_NATIVE_GOAL_TOMBSTONES) {
      const oldest = this.nativeGoalTombstones.keys().next().value;
      if (typeof oldest !== "string") break;
      this.nativeGoalTombstones.delete(oldest);
    }
  }

  private goal(
    conversationId: string,
    source: AgentGoal["source"],
  ): AgentGoal | null {
    const row = this.context.database.prepare(`
      SELECT * FROM agent_goals
      WHERE conversation_id = ? AND source = ?
    `).get(conversationId, source) as AgentGoalRow | undefined;
    return row ? agentGoalFromRow(row) : null;
  }
}
