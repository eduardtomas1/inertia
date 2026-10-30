import { z } from "zod";
import type { LocalAgentDocument, LocalAgentRunDocument, LocalAgentRunEventDocument, LocalAgentStore, LocalAgentCheckpointFilter, LocalAgentRunFilter } from "@cursor/sdk";

const identity = z.string().min(1).max(4096);
const time = z.number().finite().nonnegative();
const ref = z.object({ schemaVersion: z.literal(1), rootBlobId: identity }).strict().nullable().optional();
const agentSchema = z.object({ agentId: identity, cwd: identity, status: z.enum(["idle", "running", "error", "archived"]),
  activeRunId: identity.nullable().optional(), name: z.string().nullable().optional(), createdAt: time, updatedAt: time,
  latestCheckpoint: ref, sdkMetadata: z.record(z.string(), z.unknown()).optional() }).passthrough();
const runSchema = z.object({ agentId: identity, runId: identity, turnNumber: z.number().int().positive(),
  status: z.enum(["queued", "running", "finished", "error", "cancelled", "expired"]), createdAt: time, updatedAt: time,
  startCheckpointRef: ref, latestCheckpointRef: ref }).passthrough();
const checkpointSchema = z.object({ agentId: identity, blobId: identity, data: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u) }).strict();
const eventSchema = z.object({ runId: identity, seq: z.number().int().positive(), offset: identity, eventType: identity,
  payload: z.unknown(), payloadRef: z.string().nullable(), idempotencyKey: z.string().nullable(), createdAt: time }).strict();
const tableSchema = z.enum(["agents", "runs", "checkpoints", "runEvents"]);
const mutationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("put"), table: tableSchema, value: z.unknown() }).strict(),
  z.object({ operation: z.literal("delete"), table: tableSchema, keys: z.array(z.string()).max(100_000) }).strict(),
]);
export type CursorSdkStoreMutation = z.infer<typeof mutationSchema>;
type Table = z.infer<typeof tableSchema>;
type Row = LocalAgentDocument | LocalAgentRunDocument | LocalAgentRunEventDocument | z.infer<typeof checkpointSchema>;
function clone<T>(value: T): T { return structuredClone(value); }
function pair(first: string, second: string): string { return JSON.stringify([first, second]); }
function matches(value: string, list?: readonly string[]): boolean { return !list?.length || list.includes(value); }
function page<T>(items: T[], key: (value: T) => [number, string], descending: boolean, filter?: { cursor?: string; limit?: number }) {
  const limit = filter?.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid Cursor SDK store page limit.");
  let cursor: [number, string] | undefined;
  if (filter?.cursor) {
    if (filter.cursor.length > 16384 || !/^[A-Za-z0-9_-]+$/u.test(filter.cursor)) throw new Error("Invalid Cursor SDK store cursor.");
    cursor = z.tuple([z.number().finite(), z.string()]).parse(JSON.parse(Buffer.from(filter.cursor, "base64url").toString("utf8")));
  }
  const compare = (left: [number, string], right: [number, string]) =>
    (left[0] - right[0] || (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0)) * (descending ? -1 : 1);
  const ordered = items.sort((a, b) => compare(key(a), key(b))).filter((item) => !cursor || compare(key(item), cursor) > 0);
  const values = ordered.slice(0, limit);
  return { items: clone(values), ...(values.length < ordered.length ? { nextCursor: Buffer.from(JSON.stringify(key(values.at(-1)!))).toString("base64url") } : {}) };
}
function validated(table: Table, value: unknown): { key: string; value: Row } {
  if (table === "agents") { const row = agentSchema.parse(value); return { key: row.agentId, value: row as LocalAgentDocument }; }
  if (table === "runs") { const row = runSchema.parse(value); return { key: pair(row.agentId, row.runId), value: row as LocalAgentRunDocument }; }
  if (table === "checkpoints") { const row = checkpointSchema.parse(value); return { key: pair(row.agentId, row.blobId), value: row }; }
  const row = eventSchema.parse(value);
  if (row.offset !== String(row.seq)) throw new Error("Invalid Cursor SDK event sequence.");
  return { key: pair(row.runId, row.offset), value: row as LocalAgentRunEventDocument };
}

export class CursorSdkStoreRecords implements LocalAgentStore {
  private readonly tables: Record<Table, Map<string, Row>> = { agents: new Map(), runs: new Map(), checkpoints: new Map(), runEvents: new Map() };
  constructor(private readonly check: () => void, private readonly persist: (mutation: CursorSdkStoreMutation) => void,
    readonly dispose: () => Promise<void>, private readonly secret?: string) {}

  replay(input: unknown): void {
    const mutation = mutationSchema.parse(input);
    this.assertSecretFree(mutation);
    if (mutation.operation === "put") {
      const row = validated(mutation.table, mutation.value);
      if (mutation.table === "checkpoints" && this.secret
        && Buffer.from((row.value as z.infer<typeof checkpointSchema>).data, "base64").includes(Buffer.from(this.secret))) {
        throw new Error("Cursor SDK checkpoint rejected private credential material.");
      }
      this.tables[mutation.table].set(row.key, row.value);
    }
    else for (const key of mutation.keys) this.tables[mutation.table].delete(key);
  }
  private assertSecretFree(value: unknown): void {
    const serialized = JSON.stringify(value);
    if (this.secret && (serialized.includes(this.secret) || serialized.includes(Buffer.from(this.secret).toString("base64")))) {
      throw new Error("Cursor SDK store rejected private credential material.");
    }
    const visit = (entry: unknown): void => {
      if (!entry || typeof entry !== "object") return;
      for (const [key, child] of Object.entries(entry)) {
        if (/^(?:api[_-]?key|access[_-]?token|authorization|credential|secret)$/iu.test(key)) throw new Error("Cursor SDK store rejected credential fields.");
        visit(child);
      }
    };
    visit(value);
  }
  private put(table: Table, input: unknown, create: boolean): Row {
    this.check();
    const row = validated(table, JSON.parse(JSON.stringify(input)));
    if (this.tables[table].has(row.key) === create) throw new Error(create ? "Cursor SDK record already exists." : "Cursor SDK record is missing.");
    const mutation: CursorSdkStoreMutation = { operation: "put", table, value: row.value };
    this.persistChecked(mutation);
    this.tables[table].set(row.key, row.value);
    return clone(row.value);
  }
  private persistChecked(input: CursorSdkStoreMutation): void {
    const mutation = mutationSchema.parse(input);
    this.assertSecretFree(mutation);
    this.persist(mutation);
  }
  private get<T extends Row>(table: Table, key: string): T | null {
    this.check(); return clone((this.tables[table].get(key) as T | undefined) ?? null);
  }
  private rows<T extends Row>(table: Table): T[] { this.check(); return Array.from(this.tables[table].values()) as T[]; }
  private remove<T extends Row>(table: Table, match: (row: T) => boolean): void {
    this.check();
    const keys = [...this.tables[table]].filter(([, row]) => match(row as T)).map(([key]) => key);
    if (!keys.length) return;
    const mutation: CursorSdkStoreMutation = { operation: "delete", table, keys };
    this.persistChecked(mutation);
    for (const key of keys) this.tables[table].delete(key);
  }
  readonly agents: LocalAgentStore["agents"] = {
    get: async ({ agentId }) => this.get<LocalAgentDocument>("agents", agentId),
    create: async ({ agent }) => this.put("agents", agent, true) as LocalAgentDocument,
    update: async ({ agent }) => this.put("agents", agent, false) as LocalAgentDocument,
    delete: async ({ filter }) => this.remove<LocalAgentDocument>("agents", (row) => matches(row.agentId, filter.agentIds) && (!filter.cwd || row.cwd === filter.cwd)),
    list: async ({ filter } = {}) => page(this.rows<LocalAgentDocument>("agents").filter((row) => !filter?.cwd || row.cwd === filter.cwd), (row) => [row.updatedAt, row.agentId], true, filter),
  };
  readonly runs: LocalAgentStore["runs"] = {
    get: async ({ agentId, runId }) => this.get<LocalAgentRunDocument>("runs", pair(agentId, runId)),
    create: async ({ run }) => this.put("runs", run, true) as LocalAgentRunDocument,
    update: async ({ run }) => this.put("runs", run, false) as LocalAgentRunDocument,
    delete: async ({ filter }) => this.remove<LocalAgentRunDocument>("runs", (row) => this.matchesRun(row, filter)),
    list: async ({ filter } = {}) => page(this.rows<LocalAgentRunDocument>("runs").filter((row) => this.matchesRun(row, filter)), (row) => [row.turnNumber, pair(row.runId, row.agentId)], false, filter),
  };
  private matchesRun(row: LocalAgentRunDocument, filter?: LocalAgentRunFilter): boolean {
    return matches(row.agentId, filter?.agentIds) && matches(row.runId, filter?.runIds);
  }
  private matchesCheckpoint(row: z.infer<typeof checkpointSchema>, filter?: LocalAgentCheckpointFilter): boolean {
    return matches(row.agentId, filter?.agentIds) && matches(row.blobId, filter?.blobIds);
  }
  readonly checkpoints: LocalAgentStore["checkpoints"] = {
    get: async ({ agentId, blobId }) => { const row = this.get<z.infer<typeof checkpointSchema>>("checkpoints", pair(agentId, blobId)); return row ? Buffer.from(row.data, "base64") : null; },
    create: async ({ agentId, blobId, data }) => { this.putCheckpoint(agentId, blobId, data, true); },
    update: async ({ agentId, blobId, data }) => { this.putCheckpoint(agentId, blobId, data, false); },
    delete: async ({ filter }) => this.remove<z.infer<typeof checkpointSchema>>("checkpoints", (row) => this.matchesCheckpoint(row, filter)),
    list: async ({ filter } = {}) => page([...new Set(this.rows<z.infer<typeof checkpointSchema>>("checkpoints")
      .filter((row) => this.matchesCheckpoint(row, filter)).map((row) => row.blobId))], (row) => [0, row], false, filter),
  };
  private putCheckpoint(agentId: string, blobId: string, data: Uint8Array, create: boolean): void {
    if (data.byteLength > 6 * 1024 * 1024) throw new Error("Cursor SDK checkpoint exceeds its limit.");
    if (this.secret && Buffer.from(data).includes(Buffer.from(this.secret))) throw new Error("Cursor SDK checkpoint rejected private credential material.");
    this.put("checkpoints", { agentId, blobId, data: Buffer.from(data).toString("base64") }, create);
  }
  readonly runEvents: LocalAgentStore["runEvents"] = {
    append: async (input) => {
      const events = this.rows<LocalAgentRunEventDocument>("runEvents").filter((row) => row.runId === input.runId);
      const existing = input.idempotencyKey == null ? undefined : events.find((row) => row.idempotencyKey === input.idempotencyKey);
      if (existing) return clone(existing);
      const seq = events.reduce((maximum, row) => Math.max(maximum, row.seq), 0) + 1;
      return this.put("runEvents", { ...input, seq, offset: String(seq), payload: input.payload ?? null,
        payloadRef: input.payloadRef ?? null, idempotencyKey: input.idempotencyKey ?? null, createdAt: Date.now() }, true) as LocalAgentRunEventDocument;
    },
    list: async ({ runId, afterOffset, limit = 100 }) => {
      const after = afterOffset == null ? 0 : Number(afterOffset);
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid Cursor SDK event page.");
      const rows = this.rows<LocalAgentRunEventDocument>("runEvents").filter((row) => row.runId === runId && row.seq > after).sort((a, b) => a.seq - b.seq);
      const items = clone(rows.slice(0, limit));
      return { items, ...(rows.length > limit ? { nextOffset: items.at(-1)!.offset } : {}) };
    },
    delete: async ({ filter }) => this.remove<LocalAgentRunEventDocument>("runEvents", (row) => matches(row.runId, filter.runIds)),
  };
}
