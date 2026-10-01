import type Database from "better-sqlite3";
import { linkedPullRequestSchema, pullRequestIdentity, stackOperationSchema, stackReviewSchema,
  type LinkedPullRequest, type PullRequestKey, type StackOperation, type StackReview } from "../../shared/pull-requests";
export class PullRequestRepositoryError extends Error {}

export class PullRequestRepository {
  constructor(private readonly database: Database.Database) {}
  list(conversationId: string): LinkedPullRequest[] {
    return (this.database.prepare("SELECT value_json FROM conversation_pull_requests WHERE conversation_id=? ORDER BY rowid").all(conversationId) as Array<{ value_json: string }>).map((row) => linkedPullRequestSchema.parse(JSON.parse(row.value_json)));
  }
  get(conversationId: string, key: PullRequestKey): LinkedPullRequest | null {
    const row = this.database.prepare("SELECT value_json FROM conversation_pull_requests WHERE conversation_id=? AND identity=?").get(conversationId, pullRequestIdentity(key)) as { value_json: string } | undefined;
    return row ? linkedPullRequestSchema.parse(JSON.parse(row.value_json)) : null;
  }
  save(conversationId: string, value: LinkedPullRequest): void {
    linkedPullRequestSchema.parse(value);
    const previous = this.get(conversationId, value);
    if (value.source !== "stack-dismissed" && (!previous || previous.source === "stack-dismissed")
      && this.list(conversationId).filter((link) => link.source !== "stack-dismissed").length >= 200) {
      throw new PullRequestRepositoryError("This chat has reached its 200 pull request link limit.");
    }
    this.database.prepare(`INSERT INTO conversation_pull_requests VALUES (?, ?, ?) ON CONFLICT(conversation_id, identity) DO UPDATE SET value_json=excluded.value_json`)
      .run(conversationId, pullRequestIdentity(value), JSON.stringify(value));
  }
  unlink(conversationId: string, key: PullRequestKey): void {
    const link = this.get(conversationId, key);
    if (link) this.save(conversationId, { ...link, source: "stack-dismissed" });
  }
  assertDeletionAllowed(ownerId: string, project = false): void {
    const row = this.database.prepare(`SELECT 1 FROM pull_request_stack_operations AS operation
      JOIN conversations AS conversation ON conversation.id=operation.conversation_id
      WHERE ${project ? "conversation.project_id" : "conversation.id"}=? AND operation.state IN ('running','pending','unknown') LIMIT 1`).get(ownerId);
    if (row) throw new PullRequestRepositoryError("Check the pending GitHub stack action before deleting this chat or project.");
  }
  prepare(review: StackReview): void {
    this.database.prepare("DELETE FROM pull_request_stack_operations WHERE state='prepared' AND conversation_id=?").run(review.conversationId);
    this.database.prepare("INSERT INTO pull_request_stack_operations (id,conversation_id,stack_identity,review_json,state) VALUES (?,?,?,?,'prepared')")
      .run(review.id, review.conversationId, `${review.key.host}/${review.key.repository.toLowerCase()}/stack/${review.stack.number}`, JSON.stringify(review));
  }
  review(conversationId: string, id: string): StackReview | null {
    const row = this.database.prepare("SELECT review_json FROM pull_request_stack_operations WHERE conversation_id=? AND id=?").get(conversationId, id) as { review_json: string } | undefined;
    return row ? stackReviewSchema.parse(JSON.parse(row.review_json)) : null;
  }
  claim(review: StackReview): boolean {
    try {
      return this.database.transaction(() => {
        const row = this.database.prepare("SELECT state FROM pull_request_stack_operations WHERE conversation_id=? AND id=?")
          .get(review.conversationId, review.id) as { state: string } | undefined;
        if (row?.state !== "prepared") return false;
        const active = this.database.prepare("SELECT COUNT(*) AS count FROM pull_request_stack_operations WHERE conversation_id=? AND state IN ('running','pending','unknown')")
          .get(review.conversationId) as { count: number };
        if (active.count >= 20) throw new PullRequestRepositoryError("Check this chat's pending stack actions before starting another one.");
        // Stack membership can change while a remote outcome is unknown. Keep
        // the claim on the affected PR identities as well as the stack number.
        const overlap = this.database.prepare(`SELECT 1 FROM pull_request_stack_operations AS operation,
          json_each(operation.review_json, '$.layers') AS layer
          WHERE operation.state IN ('running','pending','unknown')
            AND json_extract(operation.review_json, '$.key.host')=?
            AND lower(json_extract(operation.review_json, '$.key.repository'))=?
            AND json_extract(layer.value, '$.number') IN (SELECT value FROM json_each(?)) LIMIT 1`)
          .get(review.key.host, review.key.repository.toLowerCase(), JSON.stringify(review.layers.map(({ number }) => number)));
        if (overlap) throw new PullRequestRepositoryError("A stack action is already running or needs its outcome checked.");
        return this.database.prepare("UPDATE pull_request_stack_operations SET state='running' WHERE conversation_id=? AND id=? AND state='prepared'").run(review.conversationId, review.id).changes === 1;
      })();
    } catch (error) {
      if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") throw new PullRequestRepositoryError("A stack action is already running or needs its outcome checked.");
      throw error;
    }
  }
  settle(conversationId: string, operation: StackOperation, uuid: string | null = null): void {
    this.database.prepare("UPDATE pull_request_stack_operations SET state=?, operation_json=?, merge_uuid=COALESCE(?,merge_uuid) WHERE conversation_id=? AND id=? AND state<>'prepared'")
      .run(operation.state, JSON.stringify(operation), uuid, conversationId, operation.id);
  }
  operations(conversationId: string): StackOperation[] {
    return (this.database.prepare("SELECT operation_json FROM pull_request_stack_operations WHERE conversation_id=? AND operation_json IS NOT NULL ORDER BY state IN ('running','pending','unknown') DESC, rowid DESC LIMIT 20").all(conversationId) as Array<{ operation_json: string }>).map((row) => stackOperationSchema.parse(JSON.parse(row.operation_json)));
  }
  mergeUuid(id: string): string | null {
    return (this.database.prepare("SELECT merge_uuid FROM pull_request_stack_operations WHERE id=?").get(id) as { merge_uuid: string | null } | undefined)?.merge_uuid ?? null;
  }
  recover(): void {
    const rows = this.database.prepare("SELECT conversation_id, review_json, operation_json FROM pull_request_stack_operations WHERE state='running'").all() as Array<{ conversation_id: string; review_json: string; operation_json: string | null }>;
    for (const row of rows) {
      const review = stackReviewSchema.parse(JSON.parse(row.review_json));
      this.settle(row.conversation_id, { id: review.id, key: review.key, stackNumber: review.stack.number, action: review.action,
        state: "unknown", completedLayers: row.operation_json ? stackOperationSchema.parse(JSON.parse(row.operation_json)).completedLayers : 0,
        message: "Inertia restarted during this action. Check its outcome on GitHub before making further changes.", updatedAt: new Date().toISOString() });
    }
  }
}
