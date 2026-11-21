import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

/** Bumped with the bridges; status flags installs older than this. */
export const BRIDGE_VERSION = "1.0.0";
const PROTOCOL = 1;
const MAX_SKETCHUP_RESPONSE_BYTES = 48 * 1024 * 1024;
// The restricted runner's ceiling; a larger AutoCAD answer is refused, not truncated.
const MAX_AUTOCAD_RESPONSE_BYTES = 1024 * 1024;
const STATUS_TIMEOUT_MS = 8_000;
const AUTOCAD_STATUS_TIMEOUT_MS = 30_000;

export const appLabel = (app: CadApp): string => (app === "autocad" ? "AutoCAD" : "SketchUp");

const bridgeResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string().max(64), message: z.string().max(2_000) }).optional(),
});

function unwrapResponse(raw: string, app: CadApp): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CadError("HOST_ERROR", `The ${appLabel(app)} bridge sent an unreadable answer.`);
  }
  const response = bridgeResponseSchema.safeParse(parsed);
  if (!response.success) {
    throw new CadError("HOST_ERROR", `The ${appLabel(app)} bridge sent an unreadable answer.`);
  }
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

const bridgeVersionOf = (source: string): string | undefined =>
  /BRIDGE_VERSION = '([^']+)'/u.exec(source)?.[1];

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
    const lost = (code: string, message: string): CadError =>
      new CadError(sent ? code : "HOST_OFFLINE", message);
    const onAbort = (): void => finish(lost("HOST_TIMEOUT", "The SketchUp request was cancelled."));
    const timer = setTimeout(() => finish(lost(
      "HOST_TIMEOUT",
      "SketchUp did not answer in time. It may be busy or showing a dialog.",
    )), timeoutMs);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      sent = true;
      socket.write(`${JSON.stringify({ v: PROTOCOL, id: randomUUID(), token: endpoint.token, method, params })}\n`);
    });
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (received.length > MAX_SKETCHUP_RESPONSE_BYTES) {
        return finish(new CadError("HOST_ERROR", "SketchUp sent more data than Inertia accepts."));
      }
      const end = received.indexOf("\n");
      if (end >= 0) finish(undefined, received.slice(0, end));
    });
    socket.on("error", () => finish(lost("HOST_DISCONNECTED", "The connection to SketchUp failed.")));
    socket.on("close", () => finish(lost("HOST_DISCONNECTED", "SketchUp closed the connection.")));
  }).then((raw) => unwrapResponse(raw, "sketchup"));
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
      const folders = await sketchUpVersionFolders(settingsBase);
      const installed = await Promise.all(folders.map((folder) => installedVersion(folder.plugins)));
      const anyInstalled = installed.some((version) => version !== undefined);
      const outdated = installed.some((version) => version !== undefined && version !== BRIDGE_VERSION);
      if (live.length === 0) {
        if (folders.length === 0) {
          return {
            app: "sketchup",
            state: "not_installed",
            hint: "SketchUp Pro desktop was not found. Open it once after installing so it creates its settings folder.",
            documents: [],
          };
        }
        const ready = anyInstalled && !outdated;
        return {
          app: "sketchup",
          state: ready ? "not_running" : "setup_required",
          hint: ready
            ? "Open SketchUp (restart it if it was open while the extension was installed)."
            : "Call inertia_cad_setup to install the SketchUp extension, then restart SketchUp.",
          documents: [],
        };
      }
      const documents = live.flatMap((answer) => answer.documents);
      const failed = live.every(({ error }) => error !== undefined);
      // A malformed answer is an outdated or broken bridge, not a busy SketchUp.
      const broken = failed && live.every(({ error }) => error?.code === "HOST_ERROR");
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
      const folders = await sketchUpVersionFolders(settingsBase);
      return folders.flatMap((folder) => [
        join(folder.plugins, "inertia_cad_bridge.rb"),
        join(folder.plugins, "inertia_cad_bridge", "main.rb"),
      ]);
    },
    async setup() {
      const folders = await sketchUpVersionFolders(settingsBase);
      if (folders.length === 0) {
        throw new CadError(
          "NOT_INSTALLED",
          "SketchUp desktop was not found. Install SketchUp Pro or Studio and open it once, then run setup again.",
        );
      }
      try {
        for (const folder of folders) {
          await mkdir(join(folder.plugins, "inertia_cad_bridge"), { recursive: true });
          await writeFile(join(folder.plugins, "inertia_cad_bridge.rb"), SKETCHUP_LOADER_RB);
          await writeFile(join(folder.plugins, "inertia_cad_bridge", "main.rb"), SKETCHUP_MAIN_RB);
        }
      } catch {
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
  NOT_INSTALLED: "not_installed",
  HOST_BUSY: "busy",
};

export type AutoCadRunner = (
  executable: string,
  args: readonly string[],
  options: { cwd: string; input: string; timeoutMs: number; signal?: AbortSignal | undefined },
) => Promise<{ stdout: string }>;

const restrictedRunner: AutoCadRunner = async (executable, args, options) => await runRestrictedCli(executable, args, {
  ...options,
  maxOutputBytes: MAX_AUTOCAD_RESPONSE_BYTES,
  failureMessage: "The AutoCAD bridge stopped unexpectedly.",
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
  const ensureScript = async (): Promise<void> => {
    if (await stat(scriptPath).then(() => true, () => false)) return;
    try {
      await mkdir(dirname(scriptPath), { recursive: true });
      const temporary = `${scriptPath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `\uFEFF${AUTOCAD_BRIDGE_PS1}`);
      await rename(temporary, scriptPath);
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
    try {
      ({ stdout } = await run(
        powershell,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-File", scriptPath],
        {
          cwd: stateDirectory,
          input: JSON.stringify({ v: PROTOCOL, id: randomUUID(), method, params }),
          timeoutMs,
          signal,
        },
      ));
    } catch (error) {
      if (!(error instanceof RestrictedCliError)) throw error;
      switch (error.code) {
        case "unavailable":
          throw new CadError("HOST_ERROR", "Windows PowerShell could not start.");
        case "output-limit":
          throw new CadError(
            "HOST_ERROR",
            method === "capture"
              ? "The AutoCAD capture is too large. Try a smaller maxWidth and maxHeight."
              : "AutoCAD sent more data than Inertia accepts. Ask for fewer objects with limit.",
          );
        case "timeout":
        case "cleanup":
          throw new CadError("HOST_TIMEOUT", "AutoCAD did not answer in time. It may be busy or showing a dialog.");
        default:
          throw new CadError("HOST_DISCONNECTED", "The AutoCAD bridge stopped before it answered.");
      }
    }
    return unwrapResponse(stdout.trim(), "autocad");
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
