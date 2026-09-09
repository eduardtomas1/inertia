import { z } from "zod";

export const DIAGNOSTIC_LIMITS = {
  incidents: 500,
  pageSize: 25,
  maxPageSize: 50,
  eventBytes: 2_048,
  pendingWrites: 64,
  exportBytes: 512 * 1_024,
  changeIntervalMs: 250,
} as const;

export type DiagnosticAction = "providers" | "discord" | "conversation";
export type DiagnosticSeverity = "info" | "warning" | "error";
export type DiagnosticSubsystem = "discord" | "provider" | "runtime" | "git" | "terminal" | "application";
export type DiagnosticOutcome = "not-started" | "failed" | "unknown" | "observing" | "recovered" | "ended";

interface DiagnosticDefinition {
  severity: DiagnosticSeverity;
  subsystem: DiagnosticSubsystem;
  operation: "release-info" | "credential-storage" | "provider-connect" | "turn" | "runtime-lifecycle" | "command";
  title: string;
  cause: string;
  causeKnown: boolean;
  nextStep: string;
  action?: DiagnosticAction;
}

/** Reviewed prose only: exception messages, URLs and provider output never enter this catalog. */
export const DIAGNOSTIC_CATALOG = {
  "discord.repository-missing": {
    severity: "warning", subsystem: "discord", operation: "release-info",
    title: "A release repository is needed", causeKnown: true,
    cause: "No supported public release repository was supplied.",
    nextStep: "Add a public GitHub or GitLab repository in Discord settings. Nothing was sent.", action: "discord",
  },
  "discord.webhook-missing": {
    severity: "warning", subsystem: "discord", operation: "release-info",
    title: "A Discord webhook is needed", causeKnown: true,
    cause: "A valid webhook was not available in secure storage.",
    nextStep: "Save a valid webhook in Discord settings. Nothing was sent.", action: "discord",
  },
  "discord.credential-unavailable": {
    severity: "error", subsystem: "discord", operation: "credential-storage",
    title: "Secure webhook storage is unavailable", causeKnown: false,
    cause: "Inertia could not complete the operating system credential-vault operation. The underlying cause is unknown.",
    nextStep: "Check that your system keyring is unlocked, then review Discord settings. No webhook is included in this report.", action: "discord",
  },
  "discord.release-fetch-failed": {
    severity: "error", subsystem: "discord", operation: "release-info",
    title: "Release information could not be prepared", causeKnown: false,
    cause: "The release service did not provide a usable response. This can be a connection, access, rate-limit or response-format problem.",
    nextStep: "Check your connection and public repository. At least two published releases are needed. Nothing was sent.", action: "discord",
  },
  "discord.comparison-limited": {
    severity: "warning", subsystem: "discord", operation: "release-info",
    title: "The comparison exceeded the preview limit", causeKnown: true,
    cause: "The comparison response exceeded the bounded local preview size. Published release notes were used instead.",
    nextStep: "Use the comparison link in the release summary for the full changes. This notice does not indicate a delivery failure.", action: "discord",
  },
  "discord.delivery-rejected": {
    severity: "error", subsystem: "discord", operation: "release-info",
    title: "Discord rejected the release message", causeKnown: true,
    cause: "Discord returned an unsuccessful HTTP response.",
    nextStep: "Check webhook permissions and the recorded HTTP status. If rate limited, wait before explicitly trying again.", action: "discord",
  },
  "discord.delivery-unknown": {
    severity: "warning", subsystem: "discord", operation: "release-info",
    title: "Discord delivery could not be confirmed", causeKnown: false,
    cause: "The send request did not return a valid delivery confirmation. The message may already have arrived.",
    nextStep: "Check the Discord channel before sending again to avoid duplicates. Inertia will not resend automatically.", action: "discord",
  },
  "provider.start-failed": {
    severity: "error", subsystem: "provider", operation: "provider-connect",
    title: "The provider could not start", causeKnown: false,
    cause: "The provider did not reach a usable startup state. The exact cause was not established.",
    nextStep: "Check the provider installation and setup status. No agent work will be retried automatically.", action: "providers",
  },
  "provider.auth-failed": {
    severity: "error", subsystem: "provider", operation: "provider-connect",
    title: "Provider authentication is required", causeKnown: true,
    cause: "The provider reported missing or rejected authentication.",
    nextStep: "Sign in through provider settings, then explicitly resume your work.", action: "providers",
  },
  "provider.connection-failed": {
    severity: "error", subsystem: "provider", operation: "provider-connect",
    title: "The provider connection failed", causeKnown: false,
    cause: "A usable provider connection could not be confirmed. Its underlying cause is unknown.",
    nextStep: "Check provider status and your connection. Review any partial work before starting again.", action: "providers",
  },
  "turn.failed": {
    severity: "error", subsystem: "provider", operation: "turn",
    title: "An agent turn did not complete", causeKnown: false,
    cause: "The runtime recorded a terminal turn failure. Diagnostics do not contain the provider transcript or establish which side effects completed.",
    nextStep: "Open the affected conversation and review partial work before deciding whether to continue.", action: "conversation",
  },
  "turn.inactivity": {
    severity: "warning", subsystem: "provider", operation: "turn",
    title: "No recent provider activity", causeKnown: false,
    cause: "No provider activity was observed during this interval. Silence alone does not establish a hang.",
    nextStep: "The existing turn deadlines remain in effect. You can inspect the conversation or stop it yourself; do not start duplicate work.", action: "conversation",
  },
  "turn.inactivity-timeout": {
    severity: "error", subsystem: "provider", operation: "turn",
    title: "The provider inactivity deadline was reached", causeKnown: true,
    cause: "The existing inactivity safety deadline expired without provider activity. Human approval and input waits are excluded.",
    nextStep: "Review the affected conversation and any partial work before continuing. A timeout does not undo external changes.", action: "conversation",
  },
  "turn.lifetime-timeout": {
    severity: "error", subsystem: "provider", operation: "turn",
    title: "The turn lifetime deadline was reached", causeKnown: true,
    cause: "The turn exceeded the existing maximum safe lifetime.",
    nextStep: "Review the conversation and partial work before explicitly continuing.", action: "conversation",
  },
  "runtime.exited": {
    severity: "error", subsystem: "runtime", operation: "runtime-lifecycle",
    title: "The local runtime stopped unexpectedly", causeKnown: false,
    cause: "The supervised runtime exited unexpectedly. An exit alone does not establish the underlying cause or completion of active work.",
    nextStep: "Wait for safe recovery, then review interrupted conversations. Diagnostics remain available offline.",
  },
  "runtime.start-failed": {
    severity: "error", subsystem: "runtime", operation: "runtime-lifecycle",
    title: "The local runtime could not become ready", causeKnown: false,
    cause: "Startup or safe recovery did not reach readiness. See the existing lifecycle support summary for its safety state.",
    nextStep: "Keep affected work unchanged. Inspect lifecycle integrity or copy the support summary; do not bypass cleanup protections.",
  },
  "runtime.restarting": {
    severity: "warning", subsystem: "runtime", operation: "runtime-lifecycle",
    title: "The local runtime is recovering", causeKnown: true,
    cause: "The existing supervisor is attempting a safe restart.",
    nextStep: "Wait for reconnection. Inertia will not replay interrupted agent work.",
  },
  "runtime.reconnected": {
    severity: "info", subsystem: "runtime", operation: "runtime-lifecycle",
    title: "The local runtime reconnected", causeKnown: true,
    cause: "The supervised runtime reached readiness again. This does not mean interrupted work was completed.",
    nextStep: "Review previous failures separately before deciding what to continue.",
  },
  "command.failed": {
    severity: "error", subsystem: "application", operation: "command",
    title: "An app operation could not complete", causeKnown: false,
    cause: "The runtime rejected or could not complete this operation. Its detailed cause and side effects were not established.",
    nextStep: "Review the original inline error and affected context before trying again.", action: "conversation",
  },
  "git.command-failed": {
    severity: "error", subsystem: "git", operation: "command",
    title: "A Git operation could not complete", causeKnown: false,
    cause: "The Git operation reported a failure. This does not establish whether repository changes occurred.",
    nextStep: "Inspect the affected repository and original inline error before repeating a mutation.", action: "conversation",
  },
  "terminal.command-failed": {
    severity: "error", subsystem: "terminal", operation: "command",
    title: "A terminal operation could not complete", causeKnown: false,
    cause: "The terminal operation reported a failure. Its process outcome may need inspection.",
    nextStep: "Inspect the affected terminal and any partial work before starting another command.", action: "conversation",
  },
  "application.validation-failed": {
    severity: "warning", subsystem: "application", operation: "command",
    title: "An operation needs attention before starting", causeKnown: true,
    cause: "Client-side validation prevented this operation from starting.",
    nextStep: "Correct the original inline validation error and try again. Nothing was started by this request.",
  },
} as const satisfies Record<string, DiagnosticDefinition>;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_CATALOG;
const codeSchema = z.enum(Object.keys(DIAGNOSTIC_CATALOG) as [DiagnosticCode, ...DiagnosticCode[]]);
const providerSchema = z.enum(["codex", "claude", "cursor", "gemini", "kimi", "opencode"]);
const timestampSchema = z.string().datetime().max(30);
const uuidSchema = z.string().uuid();
const generationSchema = z.string().max(64).refine((value) => {
  const [owner, generation, extra] = value.split(":");
  return extra === undefined && uuidSchema.safeParse(owner).success
    && /^[1-9][0-9]{0,9}$/u.test(generation ?? "");
}).nullable();

export const diagnosticContextSchema = z.object({
  providerId: providerSchema.optional(),
  projectId: uuidSchema.optional(),
  conversationId: uuidSchema.optional(),
  turnId: uuidSchema.optional(),
  requestId: uuidSchema.optional(),
}).strict();

export const diagnosticIncidentSchema = z.object({
  schemaVersion: z.literal(1),
  id: uuidSchema,
  correlationId: uuidSchema,
  code: codeSchema,
  at: timestampSchema,
  runtimeGeneration: generationSchema,
  outcome: z.enum(["not-started", "failed", "unknown", "observing", "recovered", "ended"]),
  context: diagnosticContextSchema.default({}),
  metadata: z.object({
    httpStatus: z.number().int().min(100).max(599).optional(),
    exitCode: z.number().int().min(-255).max(255).optional(),
    silenceMs: z.number().int().min(0).max(7 * 24 * 60 * 60 * 1_000).optional(),
  }).strict().default({}),
}).strict();
export type DiagnosticIncident = z.infer<typeof diagnosticIncidentSchema>;
export type DiagnosticContext = DiagnosticIncident["context"];
export type DiagnosticMetadata = DiagnosticIncident["metadata"];

export const diagnosticRecordSchema = diagnosticIncidentSchema.extend({
  severity: z.enum(["info", "warning", "error"]),
  subsystem: z.enum(["discord", "provider", "runtime", "git", "terminal", "application"]),
  operation: z.enum(["release-info", "credential-storage", "provider-connect", "turn", "runtime-lifecycle", "command"]),
  firstAt: timestampSchema,
  occurrences: z.number().int().min(1).max(1_000_000),
}).strict();
export type DiagnosticRecord = z.infer<typeof diagnosticRecordSchema>;

export const diagnosticQuerySchema = z.object({
  search: z.string().max(160).optional(),
  severity: z.enum(["attention", "all", "info", "warning", "error"]).default("attention"),
  subsystem: z.enum(["discord", "provider", "runtime", "git", "terminal", "application"]).optional(),
  providerId: providerSchema.optional(),
  projectId: uuidSchema.optional(),
  after: timestampSchema.optional(),
  incidentId: uuidSchema.optional(),
  turnId: uuidSchema.optional(),
  requestId: uuidSchema.optional(),
  offset: z.number().int().min(0).max(DIAGNOSTIC_LIMITS.incidents).default(0),
  limit: z.number().int().min(1).max(DIAGNOSTIC_LIMITS.maxPageSize).default(DIAGNOSTIC_LIMITS.pageSize),
}).strict();
export type DiagnosticQuery = z.input<typeof diagnosticQuerySchema>;
export interface DiagnosticPage {
  records: DiagnosticRecord[];
  total: number;
  nextOffset: number | null;
  persistence: "available" | "unavailable";
  runtime: "ready" | "unavailable";
  dropped: number;
  revision: number;
  currentIncidentIds: string[];
  facets: { providerIds: NonNullable<DiagnosticContext["providerId"]>[]; projectIds: string[] };
}

export const rendererDiagnosticSchema = z.object({
  code: z.enum(["discord.repository-missing", "discord.webhook-missing", "application.validation-failed"]),
  correlationId: uuidSchema,
  context: diagnosticContextSchema.optional(),
}).strict();
export type RendererDiagnostic = z.infer<typeof rendererDiagnosticSchema>;

/** Content is omitted, not redacted heuristically: no caller-supplied prose is accepted. */
export function parseDiagnosticIncident(value: unknown): DiagnosticIncident | null {
  const result = diagnosticIncidentSchema.safeParse(value);
  if (!result.success) return null;
  return new TextEncoder().encode(JSON.stringify(result.data)).byteLength <= DIAGNOSTIC_LIMITS.eventBytes
    ? result.data : null;
}

export function diagnosticDefinition(code: DiagnosticCode): DiagnosticDefinition {
  return DIAGNOSTIC_CATALOG[code];
}

export function diagnosticMatches(record: DiagnosticRecord, query: z.output<typeof diagnosticQuerySchema>): boolean {
  const definition = diagnosticDefinition(record.code);
  return (query.severity === "all" || (query.severity === "attention"
    ? definition.severity !== "info" : definition.severity === query.severity))
    && (!query.subsystem || definition.subsystem === query.subsystem)
    && (!query.providerId || record.context.providerId === query.providerId)
    && (!query.projectId || record.context.projectId === query.projectId)
    && (!query.after || record.at >= query.after)
    && (!query.incidentId || record.id === query.incidentId)
    && (!query.turnId || record.context.turnId === query.turnId)
    && (!query.requestId || record.context.requestId === query.requestId)
    && (!query.search || `${record.code} ${definition.title} ${definition.cause} ${record.correlationId}`
      .toLowerCase().includes(query.search.trim().toLowerCase()));
}
