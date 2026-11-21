import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join } from "node:path";

import { z } from "zod";

import {
  appLabel,
  CadError,
  type CadApp,
  type CadDocument,
  type CadHost,
  type CadHostStatus,
  type CadSetupResult,
} from "./cad-hosts";

const PROPOSAL_TTL_MS = 30 * 60 * 1000;
const MAX_PROPOSALS = 200;
const READ_TIMEOUT_MS = 60_000;
// Covers the user reading the approval dialog; the restricted runner caps a process at 10 minutes.
const APPLY_TIMEOUT_MS = 10 * 60 * 1000;
const SAVE_TIMEOUT_MS = 120_000;
const MAX_APPROVAL_LINES = 18;

const cadChangeSchema = z.object({
  op: z.string(),
  target: z.string(),
  field: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type CadChange = z.infer<typeof cadChangeSchema>;

const hostPreviewSchema = z.object({
  documentId: z.string(),
  documentName: z.string().optional(),
  changes: z.array(cadChangeSchema),
  fingerprints: z.record(z.string(), z.string()),
  warnings: z.array(z.string()),
});

const hostApplySchema = z.object({
  status: z.enum(["applied", "rejected"]),
  changes: z.array(cadChangeSchema).optional(),
  created: z.array(z.record(z.string(), z.unknown())).optional(),
});

const hostCaptureSchema = z.object({
  documentId: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  pngBase64: z.string(),
  scene: z.string().nullable().optional(),
});
export type CadCapture = z.infer<typeof hostCaptureSchema>;

const hostRecordSchema = z.record(z.string(), z.unknown());

const cadReceiptSchema = z.object({
  proposalId: z.string(),
  documentId: z.string(),
  status: z.enum(["applied", "rejected", "failed", "unknown", "partial"]),
  message: z.string(),
  changes: z.array(cadChangeSchema),
  created: z.array(z.record(z.string(), z.unknown())),
  at: z.string(),
});
export type CadReceipt = z.infer<typeof cadReceiptSchema>;

export interface CadOperation {
  op: string;
  [field: string]: unknown;
}

export interface CadPreview {
  proposalId: string | null;
  documentId: string;
  changes: CadChange[];
  warnings: string[];
  expiresAt: string | null;
}

export interface CadStatus {
  hosts: Omit<CadHostStatus, "documents">[];
  documents: CadDocument[];
}

interface Proposal {
  id: string;
  app: CadApp;
  documentId: string;
  operations: CadOperation[];
  fingerprints: Record<string, string>;
  changes: CadChange[];
  approvalMessage: string;
  title: string;
  expiresAt: number;
}

export interface CadServiceOptions {
  hosts: readonly CadHost[];
  /** Holds receipts.jsonl, the append-only record of every apply outcome. */
  stateDirectory: string;
  now?: () => number;
}

function decodeWith<T>(schema: z.ZodType<T>, app: CadApp, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CadError(
      "HOST_ERROR",
      `The ${appLabel(app)} bridge answered in an unexpected shape. Run inertia_cad_setup to update it.`,
    );
  }
  return parsed.data;
}

function show(value: unknown): string {
  if (value === undefined || value === null || value === "") return "none";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** The exact text the user approves in the CAD app's dialog. */
export function approvalMessage(documentName: string, changes: readonly CadChange[]): string {
  const lines = changes.slice(0, MAX_APPROVAL_LINES).map((change) => {
    const line = change.before === undefined || change.before === null
      ? `• ${change.target}: ${show(change.after)}`
      : `• ${change.target}: ${change.field} ${show(change.before)} → ${show(change.after)}`;
    return line.length > 160 ? `${line.slice(0, 157)}...` : line;
  });
  const more = changes.length > MAX_APPROVAL_LINES
    ? `\n…and ${changes.length - MAX_APPROVAL_LINES} more change(s).`
    : "";
  return `An agent in Inertia wants to change ${documentName}:\n\n${lines.join("\n")}${more}\n\nApply these changes? You can undo them in one step.`;
}

function operationTitle(operations: readonly CadOperation[]): string {
  const kinds = [...new Set(operations.map((operation) => operation.op.replace(/^[a-z]+\./u, "")))];
  return kinds.slice(0, 3).join(", ").replaceAll("_", " ");
}

function documentLabel(documentId: string, name: string | undefined): string {
  return name ?? (basename(documentId.replace(/^acad:/u, "")) || documentId);
}

/** `Plan (Inertia copy 2026-11-21 1630).dwg`, in the user's local time. */
export function copyName(path: string, epochMillis: number): string {
  const extension = extname(path);
  const local = new Date(epochMillis);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}${pad(local.getMinutes())}`;
  return join(dirname(path), `${basename(path, extension)} (Inertia copy ${stamp})${extension}`);
}

/** Runs one task at a time: CAD writes wait on a person, and dialogs must not stack. */
class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export class CadService {
  private readonly hosts: readonly CadHost[];
  private readonly receiptsFile: string;
  private readonly now: () => number;
  private readonly proposals = new Map<string, Proposal>();
  private readonly receipts = new Map<string, CadReceipt>();
  private readonly inFlight = new Map<string, Promise<CadReceipt>>();
  private readonly writes = new WriteQueue();

  constructor(options: CadServiceOptions) {
    this.hosts = options.hosts;
    this.receiptsFile = join(options.stateDirectory, "receipts.jsonl");
    this.now = options.now ?? Date.now;
  }

  hostFor(documentId: string): CadHost {
    const host = this.hosts.find((candidate) => candidate.owns(documentId));
    if (host === undefined) {
      throw new CadError("DOCUMENT_NOT_FOUND", "Unknown documentId. Call inertia_cad_status for the open drawings and models.");
    }
    return host;
  }

  hostsFor(app: CadApp | undefined): readonly CadHost[] {
    return this.hosts.filter((host) => app === undefined || host.app === app);
  }

  async status(app?: CadApp, signal?: AbortSignal): Promise<CadStatus> {
    const statuses = await Promise.all(this.hostsFor(app).map((host) => host.status(signal)));
    return {
      hosts: statuses.map(({ documents: _documents, ...rest }) => rest),
      documents: statuses.flatMap((hostStatus) => hostStatus.documents),
    };
  }

  /** Sets up only `app` when given, so one app's missing install never fails the other. */
  async setup(app?: CadApp): Promise<{ results: CadSetupResult[] }> {
    const results: CadSetupResult[] = [];
    for (const host of this.hostsFor(app)) results.push(await host.setup());
    return { results };
  }

  async selection(input: { documentId: string; limit?: number | undefined }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.read("selection", input, signal);
  }

  async query(input: { documentId: string } & Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.read("query", input, signal);
  }

  async capture(
    input: { documentId: string; maxWidth: number; maxHeight: number },
    signal?: AbortSignal,
  ): Promise<CadCapture> {
    const host = this.hostFor(input.documentId);
    const result = await host.call("capture", input, { documentId: input.documentId, timeoutMs: READ_TIMEOUT_MS, signal });
    return decodeWith(hostCaptureSchema, host.app, result);
  }

  async preview(
    input: { documentId: string; operations: CadOperation[] },
    signal?: AbortSignal,
  ): Promise<CadPreview> {
    const host = this.hostFor(input.documentId);
    const prefix = host.app === "autocad" ? "acad." : "skp.";
    const foreign = input.operations.find((operation) => !operation.op.startsWith(prefix));
    if (foreign !== undefined) {
      throw new CadError(
        "UNSUPPORTED_OPERATION",
        `${foreign.op} is not a ${appLabel(host.app)} operation; use ${prefix}* operations for this document.`,
      );
    }
    const result = decodeWith(
      hostPreviewSchema,
      host.app,
      await host.call("preview", input, { documentId: input.documentId, timeoutMs: READ_TIMEOUT_MS, signal }),
    );
    if (result.changes.length === 0) {
      return {
        proposalId: null,
        documentId: input.documentId,
        changes: [],
        warnings: [...result.warnings, "Nothing would change, so there is nothing to apply."],
        expiresAt: null,
      };
    }
    const now = this.now();
    this.prune(now);
    const proposal: Proposal = {
      id: `cadp_${randomBytes(12).toString("base64url")}`,
      app: host.app,
      documentId: input.documentId,
      operations: input.operations,
      fingerprints: result.fingerprints,
      changes: result.changes,
      approvalMessage: approvalMessage(documentLabel(input.documentId, result.documentName), result.changes),
      title: operationTitle(input.operations),
      expiresAt: now + PROPOSAL_TTL_MS,
    };
    this.proposals.set(proposal.id, proposal);
    return {
      proposalId: proposal.id,
      documentId: input.documentId,
      changes: result.changes,
      warnings: result.warnings,
      expiresAt: new Date(proposal.expiresAt).toISOString(),
    };
  }

  /** Single use: a retried proposalId answers with its first outcome and is never sent again. */
  async apply(input: { proposalId: string }, signal?: AbortSignal): Promise<CadReceipt & { replayed?: true }> {
    const previous = await this.storedReceipt(input.proposalId);
    if (previous !== undefined) return { ...previous, replayed: true };
    const running = this.inFlight.get(input.proposalId);
    if (running !== undefined) return await running;
    const proposal = this.proposals.get(input.proposalId);
    if (proposal === undefined || proposal.expiresAt <= this.now()) {
      this.proposals.delete(input.proposalId);
      throw new CadError("PROPOSAL_EXPIRED", "That proposal is unknown or expired. Call inertia_cad_preview_changes again.");
    }
    this.proposals.delete(proposal.id);
    const outcome = this.writes
      .run(async () => await this.runApply(proposal, signal))
      .then(async (receipt) => await this.recordReceipt(receipt))
      .finally(() => this.inFlight.delete(proposal.id));
    this.inFlight.set(proposal.id, outcome);
    return await outcome;
  }

  /** The destination a save would write, checked before the user approves it. */
  async saveDestination(input: { documentId: string; destination?: string | undefined }, signal?: AbortSignal): Promise<string> {
    const host = this.hostFor(input.documentId);
    const extension = host.app === "autocad" ? ".dwg" : ".skp";
    let destination = input.destination;
    if (destination === undefined) {
      const document = (await host.status(signal)).documents.find((candidate) => candidate.documentId === input.documentId);
      if (document?.path == null) {
        throw new CadError(
          "DESTINATION_REQUIRED",
          `This ${appLabel(host.app)} document has no file yet. Pass an absolute destination ending in ${extension}.`,
        );
      }
      destination = copyName(document.path, this.now());
    }
    if (!isAbsolute(destination) || extname(destination).toLowerCase() !== extension) {
      throw new CadError("INVALID_REQUEST", `destination must be an absolute path ending in ${extension}.`);
    }
    return destination;
  }

  async saveCopy(input: { documentId: string; destination: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const host = this.hostFor(input.documentId);
    const result = await this.writes.run(async () => await host.call(
      "save_copy",
      { documentId: input.documentId, path: input.destination },
      { documentId: input.documentId, timeoutMs: SAVE_TIMEOUT_MS, signal },
    ));
    return decodeWith(hostRecordSchema, host.app, result);
  }

  private async read(
    method: "selection" | "query",
    input: { documentId: string } & Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const host = this.hostFor(input.documentId);
    const result = await host.call(method, input, { documentId: input.documentId, timeoutMs: READ_TIMEOUT_MS, signal });
    return decodeWith(hostRecordSchema, host.app, result);
  }

  private prune(now: number): void {
    for (const [id, proposal] of this.proposals) {
      if (proposal.expiresAt <= now) this.proposals.delete(id);
    }
    while (this.proposals.size > MAX_PROPOSALS) {
      const oldest = this.proposals.keys().next().value;
      if (oldest === undefined) break;
      this.proposals.delete(oldest);
    }
  }

  private async runApply(proposal: Proposal, signal?: AbortSignal): Promise<CadReceipt> {
    const base = {
      proposalId: proposal.id,
      documentId: proposal.documentId,
      changes: proposal.changes,
      created: [],
      at: new Date(this.now()).toISOString(),
    };
    const app = appLabel(proposal.app);
    try {
      const host = this.hostFor(proposal.documentId);
      const result = decodeWith(hostApplySchema, host.app, await host.call(
        "apply",
        {
          documentId: proposal.documentId,
          operations: proposal.operations,
          expectedFingerprints: proposal.fingerprints,
          approvalMessage: proposal.approvalMessage,
          title: proposal.title,
        },
        { documentId: proposal.documentId, timeoutMs: APPLY_TIMEOUT_MS, signal },
      ));
      return result.status === "applied"
        ? {
          ...base,
          status: "applied",
          message: `Applied in ${app} as one undo step. It is not saved yet; use inertia_cad_save_copy for a separate file.`,
          changes: result.changes ?? proposal.changes,
          created: result.created ?? [],
        }
        : { ...base, status: "rejected", message: "The user declined this change. Nothing was modified." };
    } catch (error) {
      if (!(error instanceof CadError)) throw error;
      if (error.code === "HOST_TIMEOUT" || error.code === "HOST_DISCONNECTED") {
        return {
          ...base,
          status: "unknown",
          message: `Inertia lost contact with ${app} after sending this change, so it may or may not have been applied. Ask the user to check the drawing and its undo history; this proposal is never sent again.`,
        };
      }
      if (error.code === "PARTIALLY_APPLIED") return { ...base, status: "partial", message: error.message };
      return { ...base, status: "failed", message: `${error.code}: ${error.message}` };
    }
  }

  private async recordReceipt(receipt: CadReceipt): Promise<CadReceipt> {
    this.receipts.set(receipt.proposalId, receipt);
    // The outcome stands even if the audit line cannot be written.
    try {
      await mkdir(dirname(this.receiptsFile), { recursive: true });
      await appendFile(this.receiptsFile, `${JSON.stringify(receipt)}\n`);
    } catch {
      // The in-memory receipt still answers retries until the app restarts.
    }
    return receipt;
  }

  // Receipts outlive a restart; proposals do not, so a retried apply still finds its outcome.
  private async storedReceipt(proposalId: string): Promise<CadReceipt | undefined> {
    const cached = this.receipts.get(proposalId);
    if (cached !== undefined) return cached;
    const text = await readFile(this.receiptsFile, "utf8").catch(() => "");
    for (const line of text.split("\n").reverse()) {
      if (!line.includes(proposalId)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const receipt = cadReceiptSchema.safeParse(parsed);
      if (receipt.success && receipt.data.proposalId === proposalId) {
        this.receipts.set(proposalId, receipt.data);
        return receipt.data;
      }
    }
    return undefined;
  }
}
