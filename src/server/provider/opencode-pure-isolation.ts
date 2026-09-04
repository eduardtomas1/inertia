import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  credentialFreeProviderEnvironment,
  type ProviderEnvironment,
} from "../environment";
import type { ProcessTreeTerminator } from "../process-lifecycle";
import {
  createOwnedOpenCodeClient,
  ownedOpenCodeCredentials,
  ownedOpenCodeEnvironment,
} from "./opencode-boundary";
import { CappedProviderBuffer } from "./io";
import {
  OpenCodeServerCleanupUnconfirmedError,
  startOwnedOpenCodeServer,
  waitForOpenCodeHealth,
  withOpenCodeRequestDeadline,
} from "./opencode-owned-server";

const PROOF_TIMEOUT_MS = 10_000;
const PLUGIN_OBSERVATION_MS = 5_000;
const MAX_PROOF_CACHE_ENTRIES = 16;
const proofCache = new Set<string>();
const cleanupFailureCache = new Set<string>();
const inFlightProofs = new Map<string, Promise<void>>();
const lifetimeInFlightProofs = new WeakMap<AbortSignal, Map<string, Promise<void>>>();

export interface OpenCodePureIsolationProof {
  readonly cleanupConfirmed: boolean;
  readonly verified: boolean;
}

export interface OpenCodePureIsolationProbeOptions {
  /** Test-only observation shortening; production always uses the full window. */
  readonly pluginObservationMs?: number;
  /** Test-only request-deadline shortening; production always uses the full deadline. */
  readonly requestTimeoutMs?: number;
  /** Cancels proofs owned by this runtime lifetime without affecting another runtime. */
  readonly signal?: AbortSignal;
}

export type OpenCodePureIsolationProbe = (
  executable: string,
  version: string | undefined,
  environment: ProviderEnvironment,
  terminateProcessTree: ProcessTreeTerminator,
  options?: OpenCodePureIsolationProbeOptions,
) => Promise<OpenCodePureIsolationProof>;

class OpenCodePureIsolationCleanupError extends Error {
  constructor(cause: unknown) {
    super("OpenCode isolation-proof cleanup could not be confirmed.", { cause });
    this.name = "OpenCodePureIsolationCleanupError";
  }
}

async function executableIdentity(
  executable: string,
  version: string,
): Promise<string> {
  const resolved = await realpath(executable);
  const metadata = await stat(resolved, { bigint: true });
  if (!metadata.isFile() || metadata.size <= 0n) {
    throw new Error("The selected OpenCode executable is not a regular file.");
  }
  return [
    resolved,
    version,
    metadata.dev,
    metadata.ino,
    metadata.size,
    metadata.mtimeNs,
  ].join("\0");
}

function isolatedEnvironment(
  root: string,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment = credentialFreeProviderEnvironment(source);
  const home = join(root, "home");
  const temporary = join(root, "tmp");
  return {
    ...environment,
    APPDATA: join(root, "appdata"),
    HOME: home,
    LOCALAPPDATA: join(root, "local-appdata"),
    OPENCODE_CONFIG_DIR: join(root, "opencode-config"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    USERPROFILE: home,
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"),
  };
}

async function waitForSentinel(
  sentinel: string,
  shouldExist: boolean,
  observationMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const sentinelExists = async (): Promise<boolean> => {
    try {
      await stat(sentinel);
      return true;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error
        && error.code === "ENOENT") return false;
      throw error;
    }
  };
  const deadline = Date.now() + observationMs;
  do {
    if (signal?.aborted) {
      throw new Error("OpenCode isolation proof was cancelled.");
    }
    const exists = await sentinelExists();
    if (exists === shouldExist) {
      if (shouldExist) return;
    } else if (!shouldExist) {
      throw new Error("OpenCode --pure executed an external project plugin.");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  const exists = await sentinelExists();
  if (shouldExist && !exists) {
    throw new Error("OpenCode did not discover the isolation-proof project plugin.");
  }
  if (!shouldExist && exists) {
    throw new Error("OpenCode --pure executed an external project plugin.");
  }
}

async function exerciseServer(
  executable: string,
  root: string,
  environment: NodeJS.ProcessEnv,
  terminateProcessTree: ProcessTreeTerminator,
  pure: boolean,
  sentinel: string,
  expectedVersion: string,
  observationMs: number,
  requestTimeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const credentials = ownedOpenCodeCredentials(environment);
  let started: Awaited<ReturnType<typeof startOwnedOpenCodeServer>>;
  try {
    started = await startOwnedOpenCodeServer(
      executable,
      root,
      ownedOpenCodeEnvironment(environment, credentials),
      new CappedProviderBuffer(16 * 1024),
      terminateProcessTree,
      "OpenCode isolation-proof server process tree",
      signal,
      pure,
    );
  } catch (error) {
    if (error instanceof OpenCodeServerCleanupUnconfirmedError) {
      throw new OpenCodePureIsolationCleanupError(error);
    }
    throw error;
  }
  let operationError: unknown;
  try {
    const client = createOwnedOpenCodeClient(started.url, root, credentials);
    await waitForOpenCodeHealth(
      client,
      started.child,
      requestTimeoutMs,
      signal,
    );
    const health = await withOpenCodeRequestDeadline(
      requestTimeoutMs,
      "Timed out reading the OpenCode isolation-proof version.",
      async (signal) => await client.global.health({ signal, throwOnError: true }),
      signal,
    );
    if (health.data?.version?.replace(/^v/u, "") !== expectedVersion.replace(/^v/u, "")) {
      throw new Error("OpenCode isolation proof observed a different executable version.");
    }
    await withOpenCodeRequestDeadline(
      requestTimeoutMs,
      "Timed out exercising the OpenCode isolation-proof server.",
      async (signal) => {
        await client.provider.list(
          { directory: root },
          { signal, throwOnError: true },
        );
        await client.app.agents(
          { directory: root },
          { signal, throwOnError: true },
        );
      },
      signal,
    );
    await waitForSentinel(sentinel, !pure, observationMs, signal);
  } catch (error) {
    operationError = error;
  }
  try {
    await started.terminate(true);
  } catch (cleanupError) {
    throw new OpenCodePureIsolationCleanupError(new AggregateError(
      operationError ? [operationError, cleanupError] : [cleanupError],
      "OpenCode isolation proof and cleanup failed.",
    ));
  }
  if (operationError) throw operationError;
}

async function runProof(
  executable: string,
  version: string,
  environment: ProviderEnvironment,
  terminateProcessTree: ProcessTreeTerminator,
  observationMs: number,
  requestTimeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "inertia-opencode-isolation-"));
  let preserveForCleanupFailure = false;
  try {
    if (process.platform !== "win32") await chmod(root, 0o700);
    const pluginDirectory = join(root, ".opencode", "plugins");
    const sentinel = join(root, `plugin-${randomUUID()}`);
    await mkdir(pluginDirectory, { recursive: true, mode: 0o700 });
    const plugin = join(pluginDirectory, "inertia-isolation-proof.js");
    await writeFile(plugin, [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(sentinel)}, "executed", "utf8");`,
      "export const InertiaIsolationProof = async () => ({});",
      "",
    ].join("\n"), { encoding: "utf8", mode: 0o600 });
    const proofEnvironment = isolatedEnvironment(root, environment.env);
    for (const path of [
      proofEnvironment.APPDATA,
      proofEnvironment.HOME,
      proofEnvironment.LOCALAPPDATA,
      proofEnvironment.OPENCODE_CONFIG_DIR,
      proofEnvironment.TMPDIR,
      proofEnvironment.XDG_CACHE_HOME,
      proofEnvironment.XDG_CONFIG_HOME,
      proofEnvironment.XDG_DATA_HOME,
    ]) {
      if (path) await mkdir(path, { recursive: true, mode: 0o700 });
    }
    await exerciseServer(
      executable,
      root,
      proofEnvironment,
      terminateProcessTree,
      false,
      sentinel,
      version,
      observationMs,
      requestTimeoutMs,
      signal,
    );
    await unlink(sentinel);
    await exerciseServer(
      executable,
      root,
      proofEnvironment,
      terminateProcessTree,
      true,
      sentinel,
      version,
      observationMs,
      requestTimeoutMs,
      signal,
    );
  } catch (error) {
    preserveForCleanupFailure = error instanceof OpenCodePureIsolationCleanupError;
    throw error;
  } finally {
    if (!preserveForCleanupFailure) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

export const probeOpenCodePureIsolation: OpenCodePureIsolationProbe = async (
  executable,
  version,
  environment,
  terminateProcessTree,
  options,
) => {
  let identity: string | undefined;
  try {
    if (options?.signal?.aborted) {
      throw new Error("OpenCode isolation proof was cancelled.");
    }
    if (!version) throw new Error("OpenCode did not report a usable version.");
    const observationMs = process.env.NODE_ENV === "test"
      && Number.isSafeInteger(options?.pluginObservationMs)
      && (options?.pluginObservationMs ?? 0) > 0
      ? Math.min(options?.pluginObservationMs ?? PLUGIN_OBSERVATION_MS, PLUGIN_OBSERVATION_MS)
      : PLUGIN_OBSERVATION_MS;
    const requestTimeoutMs = process.env.NODE_ENV === "test"
      && Number.isSafeInteger(options?.requestTimeoutMs)
      && (options?.requestTimeoutMs ?? 0) > 0
      ? Math.min(options?.requestTimeoutMs ?? PROOF_TIMEOUT_MS, PROOF_TIMEOUT_MS)
      : PROOF_TIMEOUT_MS;
    identity = await executableIdentity(executable, version);
    if (cleanupFailureCache.has(identity)) {
      return { cleanupConfirmed: false, verified: false };
    }
    if (proofCache.has(identity)) {
      return { cleanupConfirmed: true, verified: true };
    }
    const proofKey = identity;
    const lifetimeSignal = options?.signal;
    let scopedProofs = lifetimeSignal
      ? lifetimeInFlightProofs.get(lifetimeSignal)
      : inFlightProofs;
    if (!scopedProofs && lifetimeSignal) {
      scopedProofs = new Map<string, Promise<void>>();
      lifetimeInFlightProofs.set(lifetimeSignal, scopedProofs);
    }
    if (!scopedProofs) throw new Error("OpenCode isolation proof scope is unavailable.");
    let proof = scopedProofs.get(proofKey);
    if (!proof) {
      const proofSignal = lifetimeSignal ?? new AbortController().signal;
      proof = (async () => {
        await runProof(
          executable,
          version,
          environment,
          terminateProcessTree,
          observationMs,
          requestTimeoutMs,
          proofSignal,
        );
        if (await executableIdentity(executable, version) !== proofKey) {
          throw new Error("The selected OpenCode executable changed during isolation proof.");
        }
        if (proofCache.size >= MAX_PROOF_CACHE_ENTRIES) {
          proofCache.delete(proofCache.values().next().value as string);
        }
        proofCache.add(proofKey);
      })();
      scopedProofs.set(proofKey, proof);
      void proof.then(
        () => {
          if (scopedProofs.get(proofKey) === proof) {
            scopedProofs.delete(proofKey);
          }
        },
        () => {
          if (scopedProofs.get(proofKey) === proof) {
            scopedProofs.delete(proofKey);
          }
        },
      );
    }
    await proof;
    if (options?.signal?.aborted) {
      throw new Error("OpenCode isolation proof was cancelled.");
    }
    return { cleanupConfirmed: true, verified: true };
  } catch (error) {
    if (identity && error instanceof OpenCodePureIsolationCleanupError) {
      cleanupFailureCache.add(identity);
    }
    return {
      cleanupConfirmed: !(error instanceof OpenCodePureIsolationCleanupError),
      verified: false,
    };
  }
};
