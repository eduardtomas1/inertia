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
import {
  CAD_GUIDE_AUTOCAD,
  CAD_GUIDE_PRESENTATION,
  CAD_GUIDE_SKETCHUP,
} from "./bridge-sources";
import { CadExporter, type CadExportInput, type CadExportResult } from "./cad-export";

export type CadGuideTopic = "autocad" | "sketchup" | "presentation";

const GUIDES: Readonly<Record<CadGuideTopic, string>> = {
  autocad: CAD_GUIDE_AUTOCAD,
  sketchup: CAD_GUIDE_SKETCHUP,
  presentation: CAD_GUIDE_PRESENTATION,
};

const PROPOSAL_TTL_MS = 30 * 60 * 1000;
const MAX_PROPOSALS = 200;
// Every call, edits included, answers before OpenCode's 30-second host-tool timeout; reads stop
// early and page.
const CALL_TIMEOUT_MS = 28_000;
const SAVE_TIMEOUT_MS = 120_000;
// Older receipts only answer retries of proposals that expired long ago.
const MAX_RECEIPT_LINES = 5000;

/**
 * Failures that leave the edit unsent or refused before any step ran, so it can be retried.
 * The bridges report anything from the first step on as PARTIALLY_APPLIED, APPLY_FAILED, or
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

const cadBoxSchema = z.object({ min: z.array(z.number()), max: z.array(z.number()) });
export type CadBox = z.infer<typeof cadBoxSchema>;

const hostPreviewSchema = z.object({
  documentId: z.string(),
  changes: z.array(cadChangeSchema),
  fingerprints: z.record(z.string(), z.string()),
  warnings: z.array(z.string()),
  /** What the change touches, before and after, to frame a capture. */
  bbox: cadBoxSchema.optional(),
});

const hostApplySchema = z.object({
  // A SketchUp extension older than 1.2.0 still asks in a dialog and can answer rejected or expired.
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
  // rejected and expired come only from an older SketchUp extension's dialog, or older receipts.
  status: z.enum(["applied", "failed", "unknown", "partial", "rejected", "expired"]),
  message: z.string(),
  changes: z.array(cadChangeSchema),
  created: z.array(z.record(z.string(), z.unknown())),
  at: z.string(),
});
export type CadReceipt = z.infer<typeof cadReceiptSchema>;

export type CadApplyResult = CadReceipt & { replayed?: true };

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
  /** The area the change touches, before and after; AutoCAD only. */
  bbox?: CadBox;
}

export interface CadStatus {
  hosts: Omit<CadHostStatus, "documents">[];
  documents: CadDocument[];
  /** Whether AutoCAD's console is installed, so inertia_cad_export works. */
  headless: boolean;
}

interface Proposal {
  id: string;
  app: CadApp;
  documentId: string;
  operations: CadOperation[];
  fingerprints: Record<string, string>;
  changes: CadChange[];
  title: string;
  expiresAt: number;
}

export interface CadServiceOptions {
  hosts: readonly CadHost[];
  /** Holds receipts.jsonl, the append-only record of every apply outcome. */
  stateDirectory: string;
  now?: () => number;
  platform?: NodeJS.Platform;
  /** Where AutoCAD's console is looked up for exports; without it, exports are unavailable. */
  exports?: { programFiles?: string | undefined; systemRoot?: string | undefined };
  /** Test seam: an exporter with a fake process runner. */
  exporter?: CadExporter;
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

function operationTitle(operations: readonly CadOperation[]): string {
  const kinds = [...new Set(operations.map((operation) => operation.op.replace(/^[a-z]+\./u, "")))];
  return kinds.slice(0, 3).join(", ").replaceAll("_", " ");
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

/** Runs one task at a time: CAD writes are rare and must not interleave in the same app. */
class WriteGate {
  private busy = false;

  /**
   * Runs `task` now, or refuses with HOST_BUSY while another write runs. A write never waits in
   * line: its timeout covers the whole call, so the answer arrives within a host-tool timeout and
   * an edit never lands after its caller stopped listening. Nothing was sent, so a retry is safe.
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.busy) {
      return Promise.reject(new CadError(
        "HOST_BUSY",
        "Another CAD change or saved copy is still running. Nothing was sent; try the same request again in a moment.",
      ));
    }
    this.busy = true;
    return task().finally(() => {
      this.busy = false;
    });
  }
}

export class CadService {
  private readonly hosts: readonly CadHost[];
  private readonly receiptsFile: string;
  private readonly now: () => number;
  private readonly proposals = new Map<string, Proposal>();
  private readonly receipts = new Map<string, CadReceipt>();
  private readonly inFlight = new Map<string, { proposal: Proposal; done: Promise<CadReceipt> }>();
  private readonly writes = new WriteGate();
  private readonly platform: NodeJS.Platform;
  private receiptsLoaded: Promise<void> | undefined;
  private readonly exporter: CadExporter | undefined;

  constructor(options: CadServiceOptions) {
    this.hosts = options.hosts;
    this.receiptsFile = join(options.stateDirectory, "receipts.jsonl");
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
    this.exporter = options.exporter ?? (options.exports === undefined ? undefined : new CadExporter({
      stateDirectory: options.stateDirectory,
      platform: this.platform,
      ...(options.exports.programFiles === undefined ? {} : { programFiles: options.exports.programFiles }),
      ...(options.exports.systemRoot === undefined ? {} : { systemRoot: options.exports.systemRoot }),
      documents: async () => (await Promise.all(this.hostsFor("autocad").map(async (host) => await host.status())))
        .flatMap((status) => status.documents),
    }));
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
    const [statuses, headless] = await Promise.all([
      Promise.all(this.hostsFor(app).map((host) => host.status(signal))),
      this.exporter?.headless() ?? Promise.resolve(false),
    ]);
    return {
      hosts: statuses.map(({ documents: _documents, ...rest }) => rest),
      documents: statuses.flatMap((hostStatus) => hostStatus.documents),
      headless,
    };
  }

  guide(topic: CadGuideTopic): { topic: CadGuideTopic; guide: string } {
    return { topic, guide: GUIDES[topic] };
  }

  /** The file an export would write, for the approval card of a custom destination. */
  async exportDestination(input: CadExportInput): Promise<string> {
    return await this.requireExporter().destinationFor(input);
  }

  /** Runs AutoCAD's console on a copy; the open session and the original are never touched. */
  async export(input: CadExportInput, signal?: AbortSignal): Promise<CadExportResult> {
    return await this.requireExporter().export(input, signal);
  }

  private requireExporter(): CadExporter {
    if (this.exporter === undefined) {
      throw new CadError("UNSUPPORTED_PLATFORM", "Exports need full AutoCAD on Windows.");
    }
    return this.exporter;
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
    // Units are in inertia_cad_document_info and the tool description; repeating them costs every page.
    const { units: _units, ...rows } = await this.read("query", input, signal);
    return rows;
  }

  async info(input: { documentId: string; style?: boolean | undefined }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const host = this.hostFor(input.documentId);
    if (input.style === true && host.app !== "autocad") {
      throw new CadError(
        "INVALID_REQUEST",
        `style works only in AutoCAD; call inertia_cad_document_info without it for ${appLabel(host.app)}.`,
      );
    }
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
    const result = await host.call("capture", input, { documentId: input.documentId, timeoutMs: CALL_TIMEOUT_MS, signal });
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
      await host.call("preview", input, { documentId: input.documentId, timeoutMs: CALL_TIMEOUT_MS, signal }),
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
      ...(result.bbox === undefined ? {} : { bbox: result.bbox }),
    };
  }

  /**
   * Applies at once, with no dialog: the user's request in the chat is the approval. Single use
   * once sent: a retried proposalId answers with its first outcome and is never sent again. The
   * caller's cancellation never cancels an edit the host may already be running.
   */
  async apply(input: { proposalId: string }): Promise<CadApplyResult> {
    const previous = await this.storedReceipt(input.proposalId);
    if (previous !== undefined) return { ...previous, replayed: true };
    const running = this.inFlight.get(input.proposalId);
    if (running !== undefined) return await running.done;
    const proposal = this.proposals.get(input.proposalId);
    if (proposal === undefined || proposal.expiresAt <= this.now()) {
      this.proposals.delete(input.proposalId);
      throw new CadError("PROPOSAL_EXPIRED", "That proposal is unknown or expired. Call inertia_cad_preview_changes again.");
    }
    // Single use once sent: only a failure before any step puts it back.
    this.proposals.delete(proposal.id);
    const done = this.settle(proposal);
    this.inFlight.set(proposal.id, { proposal, done });
    return await done;
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
    const result = await host.call(method, input, { documentId: input.documentId, timeoutMs: CALL_TIMEOUT_MS, signal });
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
          title: proposal.title,
        },
        { documentId: proposal.documentId, timeoutMs: CALL_TIMEOUT_MS },
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
        return { ...base, status: "rejected", message: `Nothing was modified: the user declined it in an older ${appLabel(host.app)} extension's dialog. Call inertia_cad_setup to update the extension.` };
      case "expired":
        return { ...base, status: "expired", message: `Nothing was modified: an older ${appLabel(host.app)} extension's dialog was not answered in time. Call inertia_cad_setup to update the extension.` };
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
