import { z } from "zod";

import { isBackendCredentialSecret, MAX_BACKEND_CREDENTIAL_LENGTH } from "./backend-credentials";

/*
 * Per-initiative MCP servers. An initiative declares servers that every member
 * chat's provider session receives on providers that take externally supplied
 * MCP configuration. Inertia only passes the configuration: the provider
 * connects to an HTTP server or spawns a stdio server itself, without a shell.
 *
 * A header or environment entry holds either a plain, non-secret `value` or
 * `secret: true`. A secret's value never enters SQLite, the snapshot or the
 * renderer: the main process stores it in the credential vault under a
 * reference derived from the initiative, the server, the entry's slot and the
 * server's destination, and the runtime resolves it in memory when a provider
 * run starts. Because the reference is derived rather than stored, an entry can
 * only ever reach the secret entered for that same initiative, server, slot and
 * destination: a server moved to another URL or command has no secret until
 * one is entered for the new destination.
 */

export const MAX_INITIATIVE_MCP_SERVERS = 8;
export const MAX_INITIATIVE_MCP_SERVER_NAME_CHARS = 64;
/** Names starting with this (in any case) belong to Inertia's own host server. */
export const INITIATIVE_MCP_RESERVED_NAME_PREFIX = "inertia";
export const MAX_INITIATIVE_MCP_URL_CHARS = 2_048;
export const MAX_INITIATIVE_MCP_COMMAND_CHARS = 1_024;
export const MAX_INITIATIVE_MCP_ARGS = 32;
export const MAX_INITIATIVE_MCP_ARG_CHARS = 2_048;
export const MAX_INITIATIVE_MCP_HEADERS = 16;
export const MAX_INITIATIVE_MCP_ENV = 32;
export const MAX_INITIATIVE_MCP_ENTRY_NAME_CHARS = 128;
export const MAX_INITIATIVE_MCP_VALUE_CHARS = 4_096;
/** Secret entries across one initiative's servers; each holds one vault entry. */
export const MAX_INITIATIVE_MCP_SECRETS = 16;
export const MAX_INITIATIVE_MCP_SECRET_CHARS = MAX_BACKEND_CREDENTIAL_LENGTH;
/**
 * Exact-value redaction is the only protection once a provider repeats a
 * secret, and it can only hide a value long enough not to occur by chance in
 * identifiers and ordinary prose. Shorter secrets are refused.
 */
export const MIN_INITIATIVE_MCP_SECRET_CHARS = 8;
/** Distinct references the main process accepts per server, and servers per initiative. */
export const MAX_INITIATIVE_MCP_SECRET_SERVERS = MAX_INITIATIVE_MCP_SERVERS;
export const MAX_INITIATIVE_MCP_SECRET_REFERENCES_PER_SERVER = 32;

/** The harnesses that receive initiative MCP servers. Antigravity has no such input. */
export const INITIATIVE_MCP_HARNESSES = [
  "codex-app-server",
  "claude-agent-sdk",
  "cursor-acp",
  "kimi-acp",
  "opencode-sdk",
] as const;

export const INITIATIVE_MCP_SUPPORT_TEXT = "Codex, Claude, Cursor, Kimi Code, OpenCode. Not available on Antigravity.";

export function initiativeMcpRouteSupported(harnessId: string): boolean {
  return (INITIATIVE_MCP_HARNESSES as readonly string[]).includes(harnessId);
}

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/u;
/**
 * Names providers use for servers of their own: Codex's built-in apps server.
 * An initiative server with such a name would merge into or shadow it.
 */
const PROVIDER_RESERVED_SERVER_NAMES: ReadonlySet<string> = new Set(["codex_apps"]);
/** RFC 9110 field-name token. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const LINE_BREAK_OR_NUL = /[\0\r\n]/u;
/** A bare executable name: no separators, no shell syntax. */
const BARE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const POSIX_ABSOLUTE = /^\/[^/]/u;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/u;
/**
 * Characters a shell or `cmd.exe` would read as syntax; never part of a
 * command. Parentheses stay allowed for paths such as `C:\Program Files (x86)`.
 */
const COMMAND_SYNTAX = /[\0\r\n\t"'`<>|&;$%^*?!{}[\]]/u;

/**
 * Headers the MCP transport or HTTP itself owns. Setting them would break the
 * connection or impersonate the transport, so they are refused.
 */
const RESERVED_HEADER_NAMES: ReadonlySet<string> = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "host",
  "keep-alive",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Inertia's host bridge passes its own connection through these variables. */
const RESERVED_ENV_PREFIX = "INERTIA_";

/**
 * Headers whose value is always a credential: a plain value is refused, so it
 * can only be kept in secure storage.
 */
export const INITIATIVE_MCP_SECRET_ONLY_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);

/**
 * The provider sign-in and launch credentials Inertia itself passes to a
 * provider. A stdio server the provider starts would inherit them, so the
 * harness gives every initiative stdio server an empty value for each, and a
 * server's own variables cannot use these names.
 */
export const INITIATIVE_MCP_INERTIA_CREDENTIAL_ENV_NAMES: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
  "INERTIA_CODEX_BACKEND_TOKEN",
  "INERTIA_HOST_MCP_TOKEN",
  "KIMI_API_KEY",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
];
const INERTIA_CREDENTIAL_ENV_NAMES: ReadonlySet<string> = new Set(INITIATIVE_MCP_INERTIA_CREDENTIAL_ENV_NAMES);

/** Names that usually carry a credential; the form marks them Secret by default. */
export function isInitiativeMcpCredentialName(name: string): boolean {
  return /key|token|secret|password/iu.test(name) || INITIATIVE_MCP_SECRET_ONLY_HEADERS.has(name.trim().toLowerCase());
}

/** A header that may only hold a secret, never a plain value. */
export function isInitiativeMcpSecretOnlyHeader(name: string): boolean {
  return INITIATIVE_MCP_SECRET_ONLY_HEADERS.has(name.trim().toLowerCase());
}

const AUTHORIZATION_SCHEME = /^(Bearer|Basic|Token|Bot|Digest)\s+(\S.*)$/iu;

/**
 * Why a secret value is refused, or null. Besides the vault's own rules, a
 * secret must be long enough for exact redaction, and so must the credential
 * after an authorization scheme such as "Bearer", which a provider may print
 * on its own. The answer never contains the value.
 */
export function initiativeMcpSecretValueProblem(value: string): string | null {
  // The vault's own rules: present, bounded, one line, not the mask.
  if (!isBackendCredentialSecret(value as unknown)) {
    if (value.length > MAX_INITIATIVE_MCP_SECRET_CHARS) {
      return `Use a secret of at most ${MAX_INITIATIVE_MCP_SECRET_CHARS} characters.`;
    }
    return LINE_BREAK_OR_NUL.test(value) ? "Enter the secret on one line." : "Enter the secret.";
  }
  if (value.length < MIN_INITIATIVE_MCP_SECRET_CHARS) {
    return `Use a secret of at least ${MIN_INITIATIVE_MCP_SECRET_CHARS} characters.`;
  }
  const scheme = AUTHORIZATION_SCHEME.exec(value);
  if (scheme && scheme[2]!.length < MIN_INITIATIVE_MCP_SECRET_CHARS) {
    return `Use a credential of at least ${MIN_INITIATIVE_MCP_SECRET_CHARS} characters after “${scheme[1]}”.`;
  }
  return null;
}

/**
 * The exact strings to redact for one secret: the value, and for an
 * authorization value such as "Bearer abc…" also the credential after its
 * scheme. Nothing shorter than the minimum is ever listed, so redaction cannot
 * reach into identifiers or ordinary words.
 */
export function initiativeMcpSecretRedactionValues(value: string): string[] {
  const credential = AUTHORIZATION_SCHEME.exec(value)?.[2];
  return [value, ...(credential ? [credential] : [])]
    .filter((candidate) => candidate.length >= MIN_INITIATIVE_MCP_SECRET_CHARS);
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "[::1]"]);

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  // The URL parser has already normalised IPv4 spellings such as 127.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host);
}

/** Why a server URL is refused, or null. Plain http is allowed only on this computer. */
export function initiativeMcpUrlProblem(value: string): string | null {
  if (value.length === 0) return "Enter the server's URL.";
  if (value.length > MAX_INITIATIVE_MCP_URL_CHARS) return `Use a URL of at most ${MAX_INITIATIVE_MCP_URL_CHARS} characters.`;
  if (/[\s\0]/u.test(value)) return "Remove spaces and line breaks from the URL.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter a full URL, such as https://mcp.example.com/mcp.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "Use an https:// URL.";
  if (url.username || url.password) return "Put credentials in a secret header, not in the URL.";
  if (url.hash) return "Remove the # part of the URL.";
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    return "Use https://. Plain http:// is allowed only for this computer (localhost, 127.0.0.1 or [::1]).";
  }
  return null;
}

/** Why a stdio command is refused, or null: an absolute path or a bare executable name. */
export function initiativeMcpCommandProblem(value: string): string | null {
  if (value.length === 0) return "Enter the command that starts the server.";
  if (value.length > MAX_INITIATIVE_MCP_COMMAND_CHARS) {
    return `Use a command of at most ${MAX_INITIATIVE_MCP_COMMAND_CHARS} characters.`;
  }
  if (value !== value.trim()) return "Remove the spaces around the command.";
  if (COMMAND_SYNTAX.test(value)) return "Use a plain path or program name without quotes or shell characters.";
  if (BARE_COMMAND.test(value) && value !== "." && value !== "..") return null;
  if (POSIX_ABSOLUTE.test(value) || WINDOWS_ABSOLUTE.test(value)) return null;
  return "Use a full path (such as /usr/local/bin/server) or a program name on PATH (such as npx). Put options in the arguments.";
}

function plainText(maximum: number, label: string) {
  return z.string()
    .max(maximum, `${label} are limited to ${maximum} characters.`)
    .refine((value) => !LINE_BREAK_OR_NUL.test(value), `${label} cannot contain line breaks.`);
}

export const initiativeMcpServerNameSchema = z.string()
  .min(1, "Name the server.")
  .max(MAX_INITIATIVE_MCP_SERVER_NAME_CHARS, `Server names have at most ${MAX_INITIATIVE_MCP_SERVER_NAME_CHARS} characters.`)
  .regex(NAME_PATTERN, "Use letters, digits, - and _ only.")
  .refine(
    (value) => !value.toLowerCase().startsWith(INITIATIVE_MCP_RESERVED_NAME_PREFIX),
    "Names starting with “inertia” are reserved for Inertia's own tools.",
  )
  .refine(
    (value) => !PROVIDER_RESERVED_SERVER_NAMES.has(value.toLowerCase()),
    "A provider uses this name for its own server. Choose another name.",
  );

const headerNameSchema = z.string()
  .min(1, "Name the header.")
  .max(MAX_INITIATIVE_MCP_ENTRY_NAME_CHARS)
  .regex(HEADER_NAME_PATTERN, "Header names use letters, digits and - only.")
  .refine((value) => !RESERVED_HEADER_NAMES.has(value.toLowerCase()), "The MCP connection sets this header itself.");

const envNameSchema = z.string()
  .min(1, "Name the variable.")
  .max(MAX_INITIATIVE_MCP_ENTRY_NAME_CHARS)
  .regex(ENV_NAME_PATTERN, "Variable names use letters, digits and _ and cannot start with a digit.")
  .refine(
    (value) => !value.toUpperCase().startsWith(RESERVED_ENV_PREFIX),
    "Variables starting with INERTIA_ are reserved for Inertia.",
  )
  .refine(
    (value) => !INERTIA_CREDENTIAL_ENV_NAMES.has(value.toUpperCase()),
    "Inertia passes the provider's own sign-in in this variable and keeps it from the server. Use another name.",
  );

const plainValueSchema = plainText(MAX_INITIATIVE_MCP_VALUE_CHARS, "Values");

function entrySchema<T extends z.ZodType<string>>(name: T) {
  return z.union([
    z.strictObject({ name, value: plainValueSchema }),
    z.strictObject({ name, secret: z.literal(true) }),
  ]);
}

export const initiativeMcpHeaderSchema = entrySchema(headerNameSchema).superRefine((entry, context) => {
  if (!("secret" in entry) && isInitiativeMcpSecretOnlyHeader(entry.name)) {
    context.addIssue({ code: "custom", message: `${entry.name} carries a credential: tick Secret to keep it in secure storage.` });
  }
});
export const initiativeMcpEnvSchema = entrySchema(envNameSchema);

function uniqueNames(entries: readonly { name: string }[]): boolean {
  const names = entries.map(({ name }) => name.toLowerCase());
  return new Set(names).size === names.length;
}

const httpTransportSchema = z.strictObject({
  kind: z.literal("http"),
  url: z.string().superRefine((value, context) => {
    const problem = initiativeMcpUrlProblem(value);
    if (problem) context.addIssue({ code: "custom", message: problem });
  }),
  headers: z.array(initiativeMcpHeaderSchema)
    .max(MAX_INITIATIVE_MCP_HEADERS, `A server has at most ${MAX_INITIATIVE_MCP_HEADERS} headers.`)
    .refine(uniqueNames, "Each header can appear once."),
});

const stdioTransportSchema = z.strictObject({
  kind: z.literal("stdio"),
  command: z.string().superRefine((value, context) => {
    const problem = initiativeMcpCommandProblem(value);
    if (problem) context.addIssue({ code: "custom", message: problem });
  }),
  args: z.array(plainText(MAX_INITIATIVE_MCP_ARG_CHARS, "Arguments"))
    .max(MAX_INITIATIVE_MCP_ARGS, `A server has at most ${MAX_INITIATIVE_MCP_ARGS} arguments.`),
  // Windows reads variable names without case, so names are unique without it.
  env: z.array(initiativeMcpEnvSchema)
    .max(MAX_INITIATIVE_MCP_ENV, `A server has at most ${MAX_INITIATIVE_MCP_ENV} variables.`)
    .refine(uniqueNames, "Each variable can appear once."),
});

export const initiativeMcpTransportSchema = z.discriminatedUnion("kind", [
  httpTransportSchema,
  stdioTransportSchema,
]);

export const initiativeMcpServerSchema = z.strictObject({
  id: z.string().uuid(),
  name: initiativeMcpServerNameSchema,
  enabled: z.boolean(),
  transport: initiativeMcpTransportSchema,
});

export type InitiativeMcpTransport = z.infer<typeof initiativeMcpTransportSchema>;
export type InitiativeMcpServer = z.infer<typeof initiativeMcpServerSchema>;
export type InitiativeMcpEntry = z.infer<typeof initiativeMcpHeaderSchema>;

export function isSecretInitiativeMcpEntry(
  entry: InitiativeMcpEntry,
): entry is Extract<InitiativeMcpEntry, { secret: true }> {
  return "secret" in entry;
}

function transportEntries(transport: InitiativeMcpTransport): {
  kind: "header" | "env";
  entries: readonly InitiativeMcpEntry[];
} {
  return transport.kind === "http"
    ? { kind: "header", entries: transport.headers }
    : { kind: "env", entries: transport.env };
}

/**
 * The slot of a secret entry within its server: header names are compared
 * without case (as HTTP does), variable names exactly.
 */
export function initiativeMcpSecretSlot(kind: "header" | "env", name: string): string {
  return kind === "header" ? `header:${name.toLowerCase()}` : `env:${name}`;
}

const SECRET_SLOT_PATTERN = /^(?:header:[!#$%&'*+.^_`|~0-9a-z-]{1,128}|env:[A-Za-z_][A-Za-z0-9_]{0,127})$/u;

export function isInitiativeMcpSecretSlot(value: unknown): value is string {
  return typeof value === "string" && SECRET_SLOT_PATTERN.test(value);
}

/**
 * Where a server sends its entries: the exact URL for HTTP; for a command, the
 * program, its arguments, and the names and plain values of its variables
 * (sorted, so their order does not matter). Every secret reference includes
 * it, so a secret entered for one destination is never sent to another: a
 * changed URL or command simply has no secret until one is entered again.
 */
export function initiativeMcpServerDestination(server: Pick<InitiativeMcpServer, "transport">): string {
  const transport = server.transport;
  if (transport.kind === "http") return JSON.stringify(["http", transport.url]);
  const variables = transport.env
    .map((entry) => isSecretInitiativeMcpEntry(entry) ? [entry.name] : [entry.name, entry.value])
    .sort(([left], [right]) => (left! < right! ? -1 : left! > right! ? 1 : 0));
  return JSON.stringify(["stdio", transport.command, transport.args, variables]);
}

export interface InitiativeMcpSecretSlot {
  serverId: string;
  slot: string;
  /** The server's destination when the slot was listed; part of its vault reference. */
  destination: string;
}

/** Every secret entry's slot, in server and entry order. */
export function initiativeMcpSecretSlots(servers: readonly InitiativeMcpServer[]): InitiativeMcpSecretSlot[] {
  return servers.flatMap((server) => {
    const { kind, entries } = transportEntries(server.transport);
    const destination = initiativeMcpServerDestination(server);
    return entries
      .filter(isSecretInitiativeMcpEntry)
      .map(({ name }) => ({ serverId: server.id, slot: initiativeMcpSecretSlot(kind, name), destination }));
  });
}

/** The slots of one transport's secret entries. */
export function initiativeMcpTransportSecretSlots(transport: InitiativeMcpTransport): string[] {
  const { kind, entries } = transportEntries(transport);
  return entries.filter(isSecretInitiativeMcpEntry).map(({ name }) => initiativeMcpSecretSlot(kind, name));
}

export const initiativeMcpServersSchema = z.array(initiativeMcpServerSchema)
  .max(MAX_INITIATIVE_MCP_SERVERS, `An initiative has at most ${MAX_INITIATIVE_MCP_SERVERS} MCP servers.`)
  .superRefine((servers, context) => {
    if (new Set(servers.map(({ id }) => id)).size !== servers.length) {
      context.addIssue({ code: "custom", message: "Each server needs its own identity." });
    }
    if (!uniqueNames(servers)) {
      context.addIssue({ code: "custom", message: "Each server needs its own name." });
    }
    if (initiativeMcpSecretSlots(servers).length > MAX_INITIATIVE_MCP_SECRETS) {
      context.addIssue({
        code: "custom",
        message: `An initiative's servers hold at most ${MAX_INITIATIVE_MCP_SECRETS} secrets.`,
      });
    }
  });

/**
 * The secret slots `next` adds to and removes from `previous`. A slot is the
 * same only for the same server, entry and destination, so a server whose URL
 * or command changes removes its old slots and adds new, empty ones.
 */
export function initiativeMcpSecretSlotChanges(
  previous: readonly InitiativeMcpServer[],
  next: readonly InitiativeMcpServer[],
): { added: InitiativeMcpSecretSlot[]; removed: InitiativeMcpSecretSlot[] } {
  const key = ({ serverId, slot, destination }: InitiativeMcpSecretSlot) => JSON.stringify([serverId, slot, destination]);
  const before = initiativeMcpSecretSlots(previous);
  const after = initiativeMcpSecretSlots(next);
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));
  return {
    added: after.filter((slot) => !beforeKeys.has(key(slot))),
    removed: before.filter((slot) => !afterKeys.has(key(slot))),
  };
}

/*
 * The privileged path that stores a secret: the renderer sends it once to the
 * main process, which keeps it in the credential vault and answers only whether
 * a secret is set. Each request names the server's transport, so main derives
 * the reference for that exact destination and checks the slot is one of its
 * secret entries.
 */

export interface SetInitiativeMcpSecretRequest {
  initiativeId: string;
  serverId: string;
  transport: InitiativeMcpTransport;
  slot: string;
  value: string;
}

export interface InitiativeMcpSecretStateRequest {
  initiativeId: string;
  serverId: string;
  transport: InitiativeMcpTransport;
  slots: string[];
}

export interface InitiativeMcpSecretState {
  /** Whether each requested slot holds a secret; never the value. */
  slots: Record<string, boolean>;
  storageAvailable: boolean;
}

const UUID = z.string().uuid();
const slotSchema = z.string().refine(isInitiativeMcpSecretSlot);
export const INITIATIVE_MCP_SECRET_REQUEST_INVALID = "The MCP secret request is invalid.";

const setSecretRequestSchema = z.strictObject({
  initiativeId: UUID,
  serverId: UUID,
  transport: initiativeMcpTransportSchema,
  slot: slotSchema,
  value: z.string(),
}).superRefine((request, context) => {
  if (!initiativeMcpTransportSecretSlots(request.transport).includes(request.slot)) {
    context.addIssue({ code: "custom", message: INITIATIVE_MCP_SECRET_REQUEST_INVALID });
  }
});

const secretStateRequestSchema = z.strictObject({
  initiativeId: UUID,
  serverId: UUID,
  transport: initiativeMcpTransportSchema,
  slots: z.array(slotSchema).min(1).max(MAX_INITIATIVE_MCP_SECRET_REFERENCES_PER_SERVER)
    .refine((slots) => new Set(slots).size === slots.length),
}).superRefine((request, context) => {
  const slots = initiativeMcpTransportSecretSlots(request.transport);
  if (!request.slots.every((slot) => slots.includes(slot))) {
    context.addIssue({ code: "custom", message: INITIATIVE_MCP_SECRET_REQUEST_INVALID });
  }
});

export type InitiativeMcpSecretRequestParse<T> =
  | { ok: true; request: T }
  /** A readable refusal that never contains the secret. */
  | { ok: false; message: string };

/**
 * Parses a secret submission strictly. The value is checked separately so a
 * refusal can say what is wrong with it (too short, for example) without ever
 * repeating it.
 */
export function parseSetInitiativeMcpSecretRequest(
  value: unknown,
): InitiativeMcpSecretRequestParse<SetInitiativeMcpSecretRequest> {
  const parsed = setSecretRequestSchema.safeParse(value);
  if (!parsed.success) return { ok: false, message: INITIATIVE_MCP_SECRET_REQUEST_INVALID };
  const problem = initiativeMcpSecretValueProblem(parsed.data.value);
  return problem ? { ok: false, message: problem } : { ok: true, request: parsed.data };
}

export function parseInitiativeMcpSecretStateRequest(value: unknown): InitiativeMcpSecretStateRequest | null {
  const parsed = secretStateRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
