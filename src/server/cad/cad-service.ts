import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, posix, win32 } from "node:path";

import { z } from "zod";

import {
  appLabel,
  CadError,
  HOST_UNREADABLE,
  type CadApp,
  type CadDocument,
  type CadHost,
  type CadHostStatus,
  type CadSetupResult,
} from "./cad-hosts";

const PROPOSAL_TTL_MS = 30 * 60 * 1000;
const MAX_PROPOSALS = 200;
// Answers before OpenCode's 30-second host-tool timeout; the bridges stop reading early and page.
const READ_TIMEOUT_MS = 28_000;
// Covers the user reading the approval dialog; the restricted runner caps a process at 10 minutes.
const APPLY_TIMEOUT_MS = 10 * 60 * 1000;
// How long one apply call waits for the user before answering `pending`, under that same timeout.
const APPLY_WAIT_MS = 25_000;
const SAVE_TIMEOUT_MS = 120_000;
const MAX_APPROVAL_LINES = 18;
// Older receipts only answer retries of proposals that expired long ago.
const MAX_RECEIPT_LINES = 5000;

/**
 * Failures that leave the edit unsent or refused before the approval dialog, so it can be retried.
 * The bridges report anything after the user's click as PARTIALLY_APPLIED, APPLY_FAILED, or
 * APPLY_UNCONFIRMED instead, so these codes never stand for a consumed proposal.
 */
const NOT_SENT_CODES = new Set([
  "HOST_BUSY",
  "HOST_OFFLINE",
  "HOST_UNAVAILABLE",
  "UNDO_DISABLED",
  "TIME_BUDGET",
  "INACTIVE_DOCUMENT",
  "DOCUMENT_NOT_FOUND",
  "NOT_INSTALLED",
  "UNSUPPORTED_PLATFORM",
  "SETUP_FAILED",
  "UNAUTHORIZED",
  "CANCELLED",
]);
/** Failures after the request was sent whose outcome Inertia cannot know. */
const UNKNOWN_OUTCOME_CODES = new Set(["HOST_TIMEOUT", "HOST_DISCONNECTED", "APPLY_UNCONFIRMED", HOST_UNREADABLE]);

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
  status: z.enum(["applied", "rejected", "expired"]),
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
  status: z.enum(["applied", "rejected", "expired", "failed", "unknown", "partial"]),
  message: z.string(),
  changes: z.array(cadChangeSchema),
  created: z.array(z.record(z.string(), z.unknown())),
  at: z.string(),
});
export type CadReceipt = z.infer<typeof cadReceiptSchema>;

/** A receipt, or `pending` while the user has not answered yet; never persisted. */
export type CadApplyResult =
  | (CadReceipt & { replayed?: true })
  | (Omit<CadReceipt, "status"> & { status: "pending" });

export interface CadCaptureInput extends Record<string, unknown> {
  documentId: string;
  maxWidth: number;
  maxHeight: number;
  extents?: boolean;
  bbox?: { min: number[]; max: number[] };
}

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
  platform?: NodeJS.Platform;
  /** Test-only shortening seam for the `pending` answer; production callers omit it. */
  applyWaitMs?: number;
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

// Names come from the drawing; line breaks and control or bidi characters could hide real lines.
function singleLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").replace(/\s{2,}/gu, " ").trim();
}

function show(value: unknown): string {
  if (value === undefined || value === null || value === "") return "none";
  const text = singleLine(typeof value === "string" ? value : JSON.stringify(value));
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

const opName = (op: string): string => op.replace(/^[a-z]+\./u, "");
// Destructive operations first, so the line cap can never hide one.
const opRank = (op: string): number => (opName(op) === "erase" ? 0 : opName(op) === "move" ? 1 : 2);

/** "Erase 500 objects", "Move 1 object", "Set layer (2)". */
function opCount(op: string, count: number): string {
  const name = opName(op);
  if (name === "erase" || name === "move") {
    return `${name === "erase" ? "Erase" : "Move"} ${count} ${count === 1 ? "object" : "objects"}`;
  }
  const words = name.replaceAll("_", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} (${count})`;
}

/** The exact text the user approves in the CAD app's dialog. */
export function approvalMessage(documentName: string, unordered: readonly CadChange[]): string {
  const changes = [...unordered].sort((a, b) => opRank(a.op) - opRank(b.op));
  const counts = new Map<string, number>();
  for (const change of changes) counts.set(change.op, (counts.get(change.op) ?? 0) + 1);
  const summary = [...counts].map(([op, count]) => opCount(op, count)).join(", ");
  const lines = changes.slice(0, MAX_APPROVAL_LINES).map((change) => {
    const target = singleLine(change.target);
    const line = change.before === undefined || change.before === null
      ? `• ${target}: ${show(change.after)}`
      : `• ${target}: ${singleLine(change.field)} ${show(change.before)} → ${show(change.after)}`;
    return line.length > 160 ? `${line.slice(0, 157)}...` : line;
  });
  const more = changes.length > MAX_APPROVAL_LINES
    ? `\n…and ${changes.length - MAX_APPROVAL_LINES} more change(s).`
    : "";
  return `An agent in Inertia wants to change ${show(documentName)}:\n${singleLine(summary)}\n\n${lines.join("\n")}${more}\n\nApply these changes? You can undo them in one step.`;
}

function operationTitle(operations: readonly CadOperation[]): string {
  const kinds = [...new Set(operations.map((operation) => operation.op.replace(/^[a-z]+\./u, "")))];
  return kinds.slice(0, 3).join(", ").replaceAll("_", " ");
}

function documentLabel(documentId: string, name: string | undefined): string {
  return name ?? (basename(documentId.replace(/^acad:/u, "")) || documentId);
}

/** `Plan (Inertia copy 2026-11-21 163005).dwg`, in the user's local time. */
export function copyName(path: string, epochMillis: number): string {
  const extension = extname(path);
  const local = new Date(epochMillis);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}${pad(local.getMinutes())}${pad(local.getSeconds())}`;
  return join(dirname(path), `${basename(path, extension)} (Inertia copy ${stamp})${extension}`);
}

// Windows opens these as devices even with an extension, in any folder.
function reservedWindowsName(path: string): boolean {
  const stem = win32.basename(path).split(".")[0]?.replace(/[ .]+$/u, "") ?? "";
  return /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/iu.test(stem);
}

/**
 * An agent-supplied copy path: an absolute path on a local drive, never a share, a device path,
 * or an alternate data stream, which Windows would write somewhere other than it looks.
 */
export function checkDestination(destination: string, platform: NodeJS.Platform, extension: string): string {
  const path = platform === "win32"
    ? win32.normalize(destination)
    : posix.isAbsolute(destination) ? posix.normalize(destination) : undefined;
  if (
    path === undefined
    || (platform === "win32" && (!/^[A-Za-z]:\\/u.test(path) || path.includes(":", 2) || reservedWindowsName(path)))
    || extname(path).toLowerCase() !== extension
  ) {
    throw new CadError(
      "INVALID_REQUEST",
      platform === "win32"
        ? `destination must be an absolute path on a local drive, like C:\\Projects\\Plan copy${extension}.`
        : `destination must be an absolute path ending in ${extension}.`,
    );
  }
  return path;
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
  private readonly inFlight = new Map<string, { proposal: Proposal; done: Promise<CadReceipt> }>();
  private readonly writes = new WriteQueue();
  private readonly platform: NodeJS.Platform;
  private readonly applyWaitMs: number;
  private receiptsLoaded: Promise<void> | undefined;

  constructor(options: CadServiceOptions) {
    this.hosts = options.hosts;
    this.receiptsFile = join(options.stateDirectory, "receipts.jsonl");
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
    this.applyWaitMs = options.applyWaitMs ?? APPLY_WAIT_MS;
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

  async info(input: { documentId: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.read("info", input, signal);
  }

  async capture(input: CadCaptureInput, signal?: AbortSignal): Promise<CadCapture> {
    const host = this.hostFor(input.documentId);
    if (host.app !== "autocad" && (input.extents === true || input.bbox !== undefined)) {
      throw new CadError(
        "INVALID_REQUEST",
        `extents and bbox work only in AutoCAD; ${appLabel(host.app)} captures its current view.`,
      );
    }
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

  /**
   * Single use once sent: a retried proposalId answers with its first outcome and is never sent
   * again. Answers `pending` while the user has not decided; calling again keeps waiting. The
   * caller's cancellation never cancels an edit whose dialog the user can still approve.
   */
  async apply(input: { proposalId: string }): Promise<CadApplyResult> {
    const previous = await this.storedReceipt(input.proposalId);
    if (previous !== undefined) return { ...previous, replayed: true };
    const running = this.inFlight.get(input.proposalId);
    if (running !== undefined) return await this.awaitReceipt(running.proposal, running.done);
    const proposal = this.proposals.get(input.proposalId);
    if (proposal === undefined || proposal.expiresAt <= this.now()) {
      this.proposals.delete(input.proposalId);
      throw new CadError("PROPOSAL_EXPIRED", "That proposal is unknown or expired. Call inertia_cad_preview_changes again.");
    }
    // Single use once sent: only a failure before the approval dialog puts it back.
    this.proposals.delete(proposal.id);
    const done = this.settle(proposal);
    this.inFlight.set(proposal.id, { proposal, done });
    return await this.awaitReceipt(proposal, done);
  }

  private settle(proposal: Proposal): Promise<CadReceipt> {
    return this.writes
      .run(async () => await this.runApply(proposal))
      .then(
        async (receipt) => await this.recordReceipt(receipt),
        async (error: unknown) => {
          if (error instanceof CadError && NOT_SENT_CODES.has(error.code)) {
            if (proposal.expiresAt > this.now()) this.proposals.set(proposal.id, proposal);
            throw error;
          }
          // Crashed after the request may have reached the host.
          return await this.recordReceipt(this.unknownReceipt(proposal));
        },
      )
      .finally(() => this.inFlight.delete(proposal.id));
  }

  /** The receipt, or `pending` once this call has waited long enough for a host-tool client. */
  private async awaitReceipt(proposal: Proposal, done: Promise<CadReceipt>): Promise<CadApplyResult> {
    let timer: NodeJS.Timeout | undefined;
    const pending = new Promise<"pending">((resolve) => {
      timer = setTimeout(() => resolve("pending"), this.applyWaitMs);
      timer.unref();
    });
    try {
      const outcome = await Promise.race([done, pending]);
      if (outcome !== "pending") return outcome;
      return {
        proposalId: proposal.id,
        documentId: proposal.documentId,
        changes: proposal.changes,
        created: [],
        at: new Date(this.now()).toISOString(),
        status: "pending",
        message: "The user has not answered the approval dialog yet. Call inertia_cad_apply_changes again with the same proposalId to keep waiting; it is never applied twice.",
      };
    } finally {
      clearTimeout(timer);
    }
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
    if (input.destination !== undefined) return checkDestination(input.destination, this.platform, extension);
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
    method: "selection" | "query" | "info",
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

  private unknownReceipt(proposal: Proposal): CadReceipt {
    return {
      proposalId: proposal.id,
      documentId: proposal.documentId,
      changes: proposal.changes,
      created: [],
      at: new Date(this.now()).toISOString(),
      status: "unknown",
      message: `Inertia lost track of ${appLabel(proposal.app)} after sending this change, so it may or may not have been applied. Ask the user to check the drawing and its undo history; this proposal is never sent again.`,
    };
  }

  /** A receipt, or a `NOT_SENT_CODES` failure that leaves the proposal usable. */
  private async runApply(proposal: Proposal): Promise<CadReceipt> {
    const base = {
      proposalId: proposal.id,
      documentId: proposal.documentId,
      changes: proposal.changes,
      created: [],
      at: new Date(this.now()).toISOString(),
    };
    const host = this.hostFor(proposal.documentId);
    let answer: unknown;
    try {
      answer = await host.call(
        "apply",
        {
          documentId: proposal.documentId,
          operations: proposal.operations,
          expectedFingerprints: proposal.fingerprints,
          approvalMessage: proposal.approvalMessage,
          title: proposal.title,
        },
        { documentId: proposal.documentId, timeoutMs: APPLY_TIMEOUT_MS },
      );
    } catch (error) {
      if (!(error instanceof CadError)) throw error;
      if (NOT_SENT_CODES.has(error.code)) throw error;
      if (UNKNOWN_OUTCOME_CODES.has(error.code)) return this.unknownReceipt(proposal);
      if (error.code === "PARTIALLY_APPLIED") return { ...base, status: "partial", message: error.message };
      return { ...base, status: "failed", message: `${error.code}: ${error.message}` };
    }
    const parsed = hostApplySchema.safeParse(answer);
    if (!parsed.success) return this.unknownReceipt(proposal);
    switch (parsed.data.status) {
      case "applied":
        return {
          ...base,
          status: "applied",
          message: `Applied in ${appLabel(host.app)} as one undo step. It is not saved yet; use inertia_cad_save_copy for a separate file.`,
          changes: parsed.data.changes ?? proposal.changes,
          created: parsed.data.created ?? [],
        };
      case "rejected":
        return { ...base, status: "rejected", message: "The user declined this change. Nothing was modified." };
      case "expired":
        return {
          ...base,
          status: "expired",
          message: "The user did not approve this change in time, so nothing was modified. Preview it again if it is still wanted.",
        };
    }
  }

  private async recordReceipt(receipt: CadReceipt): Promise<CadReceipt> {
    await this.loadReceipts();
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
    await this.loadReceipts();
    return this.receipts.get(proposalId);
  }

  /** Reads the receipt log once, keeping its newest lines. */
  private loadReceipts(): Promise<void> {
    this.receiptsLoaded ??= (async () => {
      const text = await readFile(this.receiptsFile, "utf8").catch(() => "");
      const lines = text.split("\n").filter((line) => line !== "");
      const kept = lines.slice(-MAX_RECEIPT_LINES);
      for (const line of kept) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const receipt = cadReceiptSchema.safeParse(parsed);
        if (receipt.success) this.receipts.set(receipt.data.proposalId, receipt.data);
      }
      if (kept.length < lines.length) {
        const temporary = `${this.receiptsFile}.${randomBytes(6).toString("hex")}.tmp`;
        await writeFile(temporary, `${kept.join("\n")}\n`)
          .then(async () => await rename(temporary, this.receiptsFile))
          .catch(async () => await rm(temporary, { force: true }));
      }
    })();
    return this.receiptsLoaded;
  }
}
