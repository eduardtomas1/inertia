import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { objectValue } from "../codex/protocol";
import { isProcessTreeTerminationUnconfirmed, terminateProcessTreeAndWait, type ProcessTreeTerminator } from "../process-lifecycle";
import type { ProviderInstallationUseTransfer } from "./contracts";
import { CappedProviderBuffer } from "./io";
import { startOwnedOpenCodeServer } from "./opencode-owned-server";
import { OpenCode2Client } from "./opencode2-client";

export interface OpenCode2ServerOptions {
  executable: string;
  installationVersion?: string | null;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  installationUse?: ProviderInstallationUseTransfer;
  terminateProcessTree?: ProcessTreeTerminator;
}

/** A private config view leaves provider credentials and native history provider-owned. */
export function openCode2Environment(environment: NodeJS.ProcessEnv, directory: string, password: string): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(environment).filter(([key]) => ![
    "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR", "OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD",
    "OPENCODE_SERVER_USERNAME", "OPENCODE_PTY_HANDOFF", "OPENCODE_SIMULATE", "OPENCODE_MODELS_URL", "OPENCODE_MODELS_PATH",
  ].includes(key.toUpperCase())));
  return {
    ...inherited,
    OPENCODE_PASSWORD: password,
    OPENCODE_CONFIG_DIR: directory,
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      // OpenCode 2.0's policy gate runs before package resolution and module import.
      experimental: { policies: [{ action: "integration.use", resource: "plugin:*", effect: "deny" }] },
    }),
  };
}

export async function openOwnedOpenCode2Server(options: OpenCode2ServerOptions) {
  options.signal?.throwIfAborted();
  const directory = await realpath(await mkdtemp(join(tmpdir(), "inertia-opencode2-")));
  const password = randomBytes(32).toString("base64url");
  const lease = options.installationUse?.accept();
  if (options.installationUse && !lease) { await rm(directory, { recursive: true, force: true }); throw new Error("OpenCode installation authority was consumed."); }
  let started: Awaited<ReturnType<typeof startOwnedOpenCodeServer>>;
  try {
    started = await startOwnedOpenCodeServer(options.executable, options.cwd,
      openCode2Environment(options.environment, directory, password), new CappedProviderBuffer(32 * 1024),
      options.terminateProcessTree ?? terminateProcessTreeAndWait, "OpenCode 2 owned server", options.signal, false);
  } catch (error) {
    if (isProcessTreeTerminationUnconfirmed(error)) lease?.quarantine("opencode2-start-cleanup-unconfirmed");
    else { lease?.release({ cleanupConfirmed: true }); await rm(directory, { recursive: true, force: true }); }
    throw error;
  }
  let reportFailure!: (error: Error) => void;
  const failure = new Promise<Error>((resolve) => { reportFailure = resolve; });
  let closing = false; let closed: Promise<void> | undefined; let outputBytes = 0;
  const close = (): Promise<void> => {
    closing = true;
    if (!closed) closed = started.terminate(true).then(async () => {
      lease?.release({ cleanupConfirmed: true });
      await rm(directory, { recursive: true, force: true });
    }, (error: unknown) => { lease?.quarantine("opencode2-cleanup-unconfirmed"); throw error; });
    return closed;
  };
  const fail = (): void => {
    if (closing) return;
    reportFailure(new Error("OpenCode 2 owned server stopped unexpectedly."));
    void close().catch(() => undefined);
  };
  const output = (chunk: Buffer): void => { outputBytes += chunk.length; if (outputBytes > 256 * 1024) fail(); };
  started.child.stdout.on("data", output); started.child.stderr.on("data", output);
  started.child.once("error", fail); started.child.once("exit", fail);
  const client = new OpenCode2Client(started.url, password, { signal: options.signal, timeoutMs: options.timeoutMs });
  try {
    const info = objectValue(await Promise.race([client.request("GET", "/api/info"), failure.then((error) => { throw error; })]));
    if (!info || typeof info.version !== "string" || !/^2\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/iu.test(info.version)
      || options.installationVersion != null && info.version !== options.installationVersion
      || typeof info.pid !== "number" || !Number.isSafeInteger(info.pid) || info.pid < 1) throw new Error("The selected executable is not a verified OpenCode 2 server.");
    return { client, child: started.child, version: info.version, failure, close,
      redactionSecrets: [password, Buffer.from(`opencode:${password}`, "utf8").toString("base64")] };
  } catch (error) { await close(); throw error; }
}
