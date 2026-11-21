import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import { environmentValue } from "../environment";
import { RestrictedCliError, runRestrictedCli } from "../restricted-cli-runner";
import {
  AUTOCAD_BRIDGE_PS1,
  SKETCHUP_LOADER_RB,
  SKETCHUP_MAIN_RB,
} from "./bridge-sources";

export type CadApp = "autocad" | "sketchup";

/** A failure the user or agent can act on; `code` is stable, `message` says what to do. */
export class CadError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CadError";
  }
}

const cadDocumentSchema = z.object({
  documentId: z.string(),
  app: z.enum(["autocad", "sketchup"]),
  name: z.string(),
  path: z.string().nullable(),
  modified: z.boolean().nullable(),
  active: z.boolean(),
  displayUnits: z.string().nullable().optional(),
  readOnly: z.boolean().optional(),
  activeLayout: z.string().nullable().optional(),
  revision: z.number().optional(),
});
export type CadDocument = z.infer<typeof cadDocumentSchema>;

export type CadHostState =
  | "connected"
  | "not_running"
  | "setup_required"
  | "not_installed"
  | "unsupported_platform"
  | "busy"
  | "error";

export interface CadHostStatus {
  app: CadApp;
  state: CadHostState;
  appVersion?: string;
  bridgeVersion?: string;
  hint?: string;
  documents: CadDocument[];
}

export interface CadSetupResult {
  app: CadApp;
  installedFor: string[];
  restartRequired: boolean;
  note: string;
}

export type CadBridgeMethod =
  | "documents"
  | "selection"
  | "query"
  | "info"
  | "capture"
  | "preview"
  | "apply"
  | "save_copy";

export interface CadCallOptions {
  documentId: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export interface CadHost {
  readonly app: CadApp;
  owns(documentId: string): boolean;
  status(signal?: AbortSignal): Promise<CadHostStatus>;
  /**
   * One bridge request. Rejects with `HOST_TIMEOUT` or `HOST_DISCONNECTED` when
   * the request may have reached the host, so callers never treat it as not applied.
   */
  call(method: CadBridgeMethod, params: Record<string, unknown>, options: CadCallOptions): Promise<unknown>;
  /** What setup would write, for the approval card; undefined when it writes nothing. */
  setupPlan(): Promise<string[] | undefined>;
  setup(): Promise<CadSetupResult>;
}

const bridgeVersionOf = (source: string): string | undefined =>
  /BRIDGE_VERSION = '([^']+)'/u.exec(source)?.[1];

/** The embedded SketchUp bridge's version; status flags installs that differ. */
export const BRIDGE_VERSION = bridgeVersionOf(SKETCHUP_MAIN_RB) ?? "unknown";
/** SketchUp 2017-2019 run a Ruby that lacks APIs the bridge uses. */
const MIN_SKETCHUP_VERSION = "2020";
const PROTOCOL = 1;
const MAX_SKETCHUP_RESPONSE_BYTES = 48 * 1024 * 1024;
// The restricted runner's ceiling; a larger AutoCAD answer is refused, not truncated.
const MAX_AUTOCAD_RESPONSE_BYTES = 1024 * 1024;
const STATUS_TIMEOUT_MS = 8_000;
// Under OpenCode's 30-second host-tool timeout.
const AUTOCAD_STATUS_TIMEOUT_MS = 25_000;

/**
 * The request reached the host, but its answer was unreadable or too large, so it may still have
 * run. Callers treat it like `HOST_TIMEOUT`, never as "not applied".
 */
export const HOST_UNREADABLE = "HOST_UNREADABLE";

/**
 * When Inertia stops waiting, and which process waits, so a bridge never acts on a request nobody
 * will read: AutoCAD closes its dialog in time, and SketchUp refuses a late approval.
 */
function withDeadline(params: Record<string, unknown>, timeoutMs: number): Record<string, unknown> {
  return { ...params, deadlineAt: Date.now() + timeoutMs, parentPid: process.pid };
}

export const appLabel = (app: CadApp): string => (app === "autocad" ? "AutoCAD" : "SketchUp");

const bridgeResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string().max(64), message: z.string().max(2_000) }).optional(),
});

function unwrapResponse(raw: string, app: CadApp, diagnostics = ""): unknown {
  const unreadable = new CadError(HOST_UNREADABLE, `The ${appLabel(app)} bridge sent an unreadable answer.${diagnostics}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw unreadable;
  }
  const response = bridgeResponseSchema.safeParse(parsed);
  if (!response.success) throw unreadable;
  if (response.data.ok) return response.data.result;
  throw new CadError(
    response.data.error?.code ?? "HOST_ERROR",
    response.data.error?.message ?? `${appLabel(app)} reported an error.`,
  );
}

function decodeDocuments(app: CadApp, value: unknown): CadDocument[] {
  const parsed = z.object({ documents: z.array(cadDocumentSchema) }).safeParse(value);
  if (!parsed.success) {
    throw new CadError(
      "HOST_ERROR",
      `The ${appLabel(app)} bridge listed documents in an unexpected shape. Run inertia_cad_setup to update it.`,
    );
  }
  return parsed.data.documents;
}

const discoverySchema = z.object({
  app: z.literal("sketchup"),
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65_535),
  token: z.string().min(16).max(256),
  bridgeVersion: z.string().max(64),
  appVersion: z.string().max(64).optional(),
});
type SketchUpEndpoint = z.infer<typeof discoverySchema>;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Where SketchUp keeps its per-version settings folders, or undefined where SketchUp does not run. */
export function sketchUpSettingsBase(
  platform: NodeJS.Platform,
  home: string,
  appData: string | undefined,
): string | undefined {
  if (platform === "win32") return join(appData ?? join(home, "AppData", "Roaming"), "SketchUp");
  if (platform === "darwin") return join(home, "Library", "Application Support");
  return undefined;
}

/** SketchUp's per-version settings folders, which hold the Plugins folder it loads at start. */
async function sketchUpVersionFolders(base: string | undefined): Promise<{ version: string; plugins: string }[]> {
  if (base === undefined) return [];
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && /^SketchUp 20\d\d$/u.test(entry.name))
    .map((entry) => ({
      version: entry.name.slice("SketchUp ".length),
      plugins: join(base, entry.name, "SketchUp", "Plugins"),
    }))
    .sort((a, b) => a.version.localeCompare(b.version, "en"));
}

function sketchUpRequest(
  endpoint: SketchUpEndpoint,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise<string>((resolve, reject) => {
    // Whether the request left this process decides between "not applied" and "unknown".
    let sent = false;
    let received = "";
    let settled = false;
    const socket = connect({ host: "127.0.0.1", port: endpoint.port });
    const finish = (error: CadError | undefined, line?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      // One request per connection: hang up so neither side keeps an idle socket.
      socket.destroy();
      if (error) reject(error);
      else resolve(line ?? "");
    };
    // Whether the request was sent decides "not applied" against "unknown". Before sending, only a
    // refused connection means nothing listens (HOST_OFFLINE, a stale discovery file); a cancel or
    // a connect that never completes says nothing about SketchUp, so status keeps its file.
    const lost = (code: string, unsent: string, message: string): CadError =>
      new CadError(sent ? code : unsent, message);
    const onAbort = (): void => finish(lost("HOST_TIMEOUT", "CANCELLED", "The SketchUp request was cancelled."));
    const timer = setTimeout(() => finish(lost(
      "HOST_TIMEOUT",
      "HOST_UNAVAILABLE",
      "SketchUp did not answer in time. It may be busy or showing a dialog.",
    )), timeoutMs);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      sent = true;
      socket.write(`${JSON.stringify({ v: PROTOCOL, id: randomUUID(), token: endpoint.token, method, params: withDeadline(params, timeoutMs) })}\n`);
    });
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (received.length > MAX_SKETCHUP_RESPONSE_BYTES) {
        return finish(new CadError(HOST_UNREADABLE, "SketchUp sent more data than Inertia accepts."));
      }
      const end = received.indexOf("\n");
      if (end >= 0) finish(undefined, received.slice(0, end));
    });
    socket.on("error", () => finish(lost("HOST_DISCONNECTED", "HOST_OFFLINE", "The connection to SketchUp failed.")));
    socket.on("close", () => finish(lost("HOST_DISCONNECTED", "HOST_OFFLINE", "SketchUp closed the connection.")));
  }).then((raw) => unwrapResponse(raw, "sketchup"));
}

/** Refuses a link at one of the extension's own paths, so setup never writes outside the Plugins folder. */
async function refuseLink(path: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (info?.isSymbolicLink()) {
    throw new CadError("SETUP_FAILED", `${path} is a link. Inertia does not write through links; remove it, then run setup again.`);
  }
}

async function writeExtensionFile(path: string, content: string): Promise<void> {
  await refuseLink(path);
  // O_NOFOLLOW also refuses a link that appears after the check, where the platform has it.
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o644);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

/** Installs the extension into one Plugins folder, whose own path the user approved. */
async function installExtension(plugins: string): Promise<void> {
  await mkdir(plugins, { recursive: true });
  const folder = join(plugins, "inertia_cad_bridge");
  await refuseLink(folder);
  await mkdir(folder, { recursive: true });
  await writeExtensionFile(join(plugins, "inertia_cad_bridge.rb"), SKETCHUP_LOADER_RB);
  await writeExtensionFile(join(folder, "main.rb"), SKETCHUP_MAIN_RB);
}

/** Exported so tests can point it at a temporary home and settings folder. */
export function createSketchUpHost(home: string, settingsBase: string | undefined): CadHost {
  const discoveryFolder = join(home, ".inertia-cad", "hosts");

  const endpoints = async (): Promise<SketchUpEndpoint[]> => {
    const names = await readdir(discoveryFolder).catch(() => [] as string[]);
    const found: SketchUpEndpoint[] = [];
    for (const name of names) {
      if (!/^sketchup-\d+\.json$/u.test(name)) continue;
      const file = join(discoveryFolder, name);
      const raw = await readFile(file, "utf8").catch(() => undefined);
      let endpoint: SketchUpEndpoint | undefined;
      try {
        const parsed = discoverySchema.safeParse(raw === undefined ? undefined : JSON.parse(raw));
        endpoint = parsed.success ? parsed.data : undefined;
      } catch {
        endpoint = undefined;
      }
      if (endpoint === undefined) continue;
      if (processAlive(endpoint.pid)) found.push(endpoint);
      // SketchUp removes its file on quit; a crash leaves one behind.
      else await rm(file, { force: true }).catch(() => undefined);
    }
    return found;
  };

  const installedVersion = (plugins: string): Promise<string | undefined> =>
    readFile(join(plugins, "inertia_cad_bridge", "main.rb"), "utf8").then(bridgeVersionOf, () => undefined);

  const endpointFor = async (documentId: string): Promise<SketchUpEndpoint> => {
    const pid = Number(/^skp:(\d+):/u.exec(documentId)?.[1]);
    const endpoint = (await endpoints()).find((candidate) => candidate.pid === pid);
    if (endpoint === undefined) {
      throw new CadError("DOCUMENT_NOT_FOUND", "That SketchUp window is closed. Call inertia_cad_status for the open models.");
    }
    return endpoint;
  };

  return {
    app: "sketchup",
    owns: (documentId) => documentId.startsWith("skp:"),
    async status(signal) {
      const answers = await Promise.all((await endpoints()).map(async (endpoint) => {
        try {
          const documents = decodeDocuments(
            "sketchup",
            await sketchUpRequest(endpoint, "documents", {}, STATUS_TIMEOUT_MS, signal),
          );
          return { endpoint, documents, error: undefined };
        } catch (error) {
          if (!(error instanceof CadError)) throw error;
          return { endpoint, documents: [], error };
        }
      }));
      // Nothing listens on its port: a crash left the file behind and the pid now
      // belongs to another process. A busy SketchUp still accepts connections.
      const gone = answers.filter(({ error }) => error?.code === "HOST_OFFLINE");
      await Promise.all(gone.map(async ({ endpoint }) => await rm(
        join(discoveryFolder, `sketchup-${endpoint.pid}.json`),
        { force: true },
      ).catch(() => undefined)));
      const live = answers.filter((answer) => !gone.includes(answer));
      if (live.length === 0) {
        // The newest SketchUp is the one the user opens, so its copy decides.
        const newest = (await sketchUpVersionFolders(settingsBase)).at(-1);
        if (newest === undefined || newest.version < MIN_SKETCHUP_VERSION) {
          return {
            app: "sketchup",
            state: "not_installed",
            hint: newest === undefined
              ? "SketchUp Pro desktop was not found. Open it once after installing so it creates its settings folder."
              : `Inertia needs SketchUp ${MIN_SKETCHUP_VERSION} or newer; only SketchUp ${newest.version} was found.`,
            documents: [],
          };
        }
        const installed = await installedVersion(newest.plugins);
        return {
          app: "sketchup",
          state: installed === BRIDGE_VERSION ? "not_running" : "setup_required",
          hint: installed === BRIDGE_VERSION
            ? "Open SketchUp (restart it if it was open while the extension was installed)."
            : installed === undefined
              ? `Call inertia_cad_setup to install the extension for SketchUp ${newest.version}, then restart SketchUp.`
              : "The SketchUp extension is outdated. Call inertia_cad_setup, then restart SketchUp.",
          documents: [],
        };
      }
      const documents = live.flatMap((answer) => answer.documents);
      const failed = live.every(({ error }) => error !== undefined);
      // A malformed answer is an outdated or broken bridge, not a busy SketchUp.
      const broken = failed && live.every(({ error }) => error?.code === "HOST_ERROR" || error?.code === HOST_UNREADABLE);
      const stale = live.some(({ endpoint }) => endpoint.bridgeVersion !== BRIDGE_VERSION);
      const first = live[0]?.endpoint;
      return {
        app: "sketchup",
        state: broken ? "error" : failed ? "busy" : "connected",
        ...(first?.appVersion === undefined ? {} : { appVersion: first.appVersion }),
        ...(first === undefined ? {} : { bridgeVersion: first.bridgeVersion }),
        ...(broken
          ? { hint: "The SketchUp extension answered in an unexpected shape. Call inertia_cad_setup, then restart SketchUp." }
          : failed
            ? { hint: "SketchUp is running but not answering. Close any open dialog in SketchUp." }
            : stale
              ? { hint: "The SketchUp extension is outdated. Call inertia_cad_setup, then restart SketchUp." }
              : {}),
        documents,
      };
    },
    async call(method, params, { documentId, timeoutMs, signal }) {
      const endpoint = await endpointFor(documentId);
      return await sketchUpRequest(endpoint, method, params, timeoutMs, signal);
    },
    async setupPlan() {
      const folders = (await sketchUpVersionFolders(settingsBase)).filter((folder) => folder.version >= MIN_SKETCHUP_VERSION);
      return folders.flatMap((folder) => [
        join(folder.plugins, "inertia_cad_bridge.rb"),
        join(folder.plugins, "inertia_cad_bridge", "main.rb"),
      ]);
    },
    async setup() {
      const found = await sketchUpVersionFolders(settingsBase);
      const folders = found.filter((folder) => folder.version >= MIN_SKETCHUP_VERSION);
      if (folders.length === 0) {
        throw new CadError(
          "NOT_INSTALLED",
          found.length === 0
            ? "SketchUp desktop was not found. Install SketchUp Pro or Studio and open it once, then run setup again."
            : `Inertia needs SketchUp ${MIN_SKETCHUP_VERSION} or newer; only SketchUp ${found.map((folder) => folder.version).join(", ")} was found.`,
        );
      }
      try {
        for (const folder of folders) await installExtension(folder.plugins);
      } catch (error) {
        if (error instanceof CadError) throw error;
        throw new CadError("SETUP_FAILED", "Could not write to SketchUp's Plugins folder. Check its permissions.");
      }
      const running = (await endpoints()).length > 0;
      return {
        app: "sketchup",
        installedFor: folders.map((folder) => `SketchUp ${folder.version}`),
        restartRequired: running,
        note: running
          ? "Installed. Restart SketchUp so it loads the new extension."
          : "Installed. It starts the next time SketchUp opens.",
      };
    },
  };
}

const AUTOCAD_UNSUPPORTED = "AutoCAD automation needs full AutoCAD on Windows.";

const AUTOCAD_STATES: Readonly<Record<string, CadHostState>> = {
  HOST_OFFLINE: "not_running",
  HOST_UNAVAILABLE: "not_running",
  NOT_INSTALLED: "not_installed",
  HOST_BUSY: "busy",
};

export type AutoCadRunner = (
  executable: string,
  args: readonly string[],
  options: { cwd: string; input: string; timeoutMs: number; signal?: AbortSignal | undefined },
) => Promise<{ stdout: string; stderr?: string }>;

const restrictedRunner: AutoCadRunner = async (executable, args, options) => await runRestrictedCli(executable, args, {
  ...options,
  maxOutputBytes: MAX_AUTOCAD_RESPONSE_BYTES,
  failureMessage: "The AutoCAD bridge stopped unexpectedly.",
  // Keeps what PowerShell printed, such as a policy that refused the script, for the error.
  classifyFailure: (output) => output.trim().slice(-500) || null,
});

/** Exported so tests can supply the platform, state folder, and process runner. */
export function createAutoCadHost(
  platform: NodeJS.Platform,
  stateDirectory: string,
  powershell: string,
  run: AutoCadRunner = restrictedRunner,
): CadHost {
  const digest = createHash("sha256").update(AUTOCAD_BRIDGE_PS1).digest("hex").slice(0, 12);
  const scriptPath = join(stateDirectory, `InertiaCadBridge-${digest}.ps1`);

  // Windows PowerShell 5.1 reads a script without a byte-order mark in the ANSI code page.
  const script = `\uFEFF${AUTOCAD_BRIDGE_PS1}`;
  const current = (): Promise<boolean> => readFile(scriptPath, "utf8").then((text) => text === script, () => false);
  // Checked once per run: a damaged or edited copy is replaced before PowerShell runs it.
  let verified = false;
  const ensureScript = async (): Promise<void> => {
    if (verified) return;
    if (await current()) {
      verified = true;
      return;
    }
    try {
      await mkdir(dirname(scriptPath), { recursive: true });
      const temporary = `${scriptPath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, script);
      try {
        await rename(temporary, scriptPath);
      } catch (error) {
        // A concurrent first call may have put the same script there, and Windows refuses to
        // replace a file another PowerShell is reading.
        await rm(temporary, { force: true });
        if (!(await current())) throw error;
      }
      verified = true;
    } catch {
      throw new CadError("SETUP_FAILED", "Could not write the AutoCAD bridge script.");
    }
  };

  const request = async (
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    if (platform !== "win32") throw new CadError("UNSUPPORTED_PLATFORM", AUTOCAD_UNSUPPORTED);
    // Cancelled before PowerShell starts: AutoCAD never saw it, so it is not an unknown outcome.
    if (signal?.aborted) throw new CadError("CANCELLED", "The request was cancelled before it reached AutoCAD.");
    await ensureScript();
    let stdout: string;
    let stderr: string | undefined;
    try {
      ({ stdout, stderr } = await run(
        powershell,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-File", scriptPath],
        {
          cwd: stateDirectory,
          input: JSON.stringify({ v: PROTOCOL, id: randomUUID(), method, params: withDeadline(params, timeoutMs) }),
          timeoutMs,
          signal,
        },
      ));
    } catch (error) {
      if (!(error instanceof RestrictedCliError)) throw error;
      switch (error.code) {
        case "unavailable":
          throw new CadError("HOST_ERROR", "Windows PowerShell could not start.");
        // The request ran; only its answer was too large, so an apply's outcome is unknown.
        case "output-limit":
          throw new CadError(
            HOST_UNREADABLE,
            method === "capture"
              ? "The AutoCAD capture is too large. Try a smaller maxWidth and maxHeight."
              : "AutoCAD sent more data than Inertia accepts. Ask for fewer objects with limit.",
          );
        case "timeout":
        case "cleanup":
          throw new CadError("HOST_TIMEOUT", "AutoCAD did not answer in time. It may be busy or showing a dialog.");
        // PowerShell exited with an error, possibly mid-apply, so the outcome is unknown.
        default:
          throw new CadError(
            "HOST_DISCONNECTED",
            `The AutoCAD bridge stopped before it answered.${error.reason ? ` PowerShell said: ${error.reason}` : ""}`,
          );
      }
    }
    // Why PowerShell printed no JSON, such as an execution policy that refuses the script.
    const diagnostics = stderr?.trim() ? ` PowerShell said: ${stderr.trim().slice(-500)}` : "";
    return unwrapResponse(stdout.trim(), "autocad", diagnostics);
  };

  return {
    app: "autocad",
    owns: (documentId) => documentId.startsWith("acad:"),
    async status(signal) {
      if (platform !== "win32") {
        return { app: "autocad", state: "unsupported_platform", hint: AUTOCAD_UNSUPPORTED, documents: [] };
      }
      try {
        const documents = decodeDocuments("autocad", await request("documents", {}, AUTOCAD_STATUS_TIMEOUT_MS, signal));
        return { app: "autocad", state: "connected", bridgeVersion: BRIDGE_VERSION, documents };
      } catch (error) {
        if (!(error instanceof CadError)) throw error;
        return { app: "autocad", state: AUTOCAD_STATES[error.code] ?? "error", hint: error.message, documents: [] };
      }
    },
    call: async (method, params, { timeoutMs, signal }) => await request(method, params, timeoutMs, signal),
    setupPlan: () => Promise.resolve(undefined),
    setup: () => Promise.resolve({
      app: "autocad",
      installedFor: [],
      restartRequired: false,
      note: platform === "win32"
        ? "Nothing to install: Inertia talks to the running AutoCAD directly."
        : AUTOCAD_UNSUPPORTED,
    }),
  };
}

// Windows PowerShell 5.1 ships with every supported Windows; PowerShell 7 cannot reach COM objects this way.
function windowsPowerShell(systemRoot: string | undefined): string {
  return join(systemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** `stateDirectory` holds the AutoCAD bridge script Inertia runs. */
export function createCadHosts(stateDirectory: string, platform: NodeJS.Platform = process.platform): CadHost[] {
  const home = homedir();
  return [
    createAutoCadHost(
      platform,
      stateDirectory,
      windowsPowerShell(environmentValue(process.env, "SYSTEMROOT", platform)),
    ),
    createSketchUpHost(home, sketchUpSettingsBase(platform, home, environmentValue(process.env, "APPDATA", platform))),
  ];
}
