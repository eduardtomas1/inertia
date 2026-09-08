import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

import { runtimeOwnedProcessInvocation, spawnRuntimeOwnedProcess } from "../../node/runtime-owned-processes";
import { INERTIA_VERSION } from "../../shared/version";
import { createOwnedProcessTreeTermination, type ProcessTreeTerminator } from "../process-lifecycle";
import { selectKimiAcpAuthMethod } from "./acp-terminal-auth";
import { ProviderRunEventBudget } from "./io";
import { BoundedKimiJsonLineTransform } from "./kimi-acp-support";
import { validateKimiInitialize } from "./kimi-acp-projection";
import { providerProcessInvocation } from "./process";

const FRAME_BYTES = 64 * 1024;
const TOTAL_BYTES = 512 * 1024;
const MAX_EVENTS = 64;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface KimiAuthenticationProbeDependencies {
  timeoutMs?: number;
  terminateProcessTree?: ProcessTreeTerminator;
}

/** Discovers login metadata only. The caller owns any subsequent PTY launch. */
export async function probeKimiAuthentication(
  executable: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  dependencies: KimiAuthenticationProbeDependencies = {},
): Promise<ReturnType<typeof selectKimiAcpAuthMethod>> {
  const cancelled = (): Error => new Error("Kimi authentication discovery was cancelled.");
  if (signal?.aborted) throw cancelled();
  const invocation = providerProcessInvocation(executable, ["acp"], environment);
  const owned = runtimeOwnedProcessInvocation(invocation.command, invocation.args);
  const child = spawnRuntimeOwnedProcess(() => spawn(owned.command, owned.args, {
    cwd, env: environment, shell: false, detached: process.platform !== "win32",
    windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    stdio: ["pipe", "pipe", "pipe"],
  }));
  const terminate = createOwnedProcessTreeTermination(
    child, "Kimi authentication discovery process tree", dependencies.terminateProcessTree,
  );
  const wire = new BoundedKimiJsonLineTransform(FRAME_BYTES, new ProviderRunEventBudget(
    "Kimi authentication discovery", FRAME_BYTES, MAX_EVENTS, TOTAL_BYTES,
    { maxRunEvents: MAX_EVENTS, maxRunBytes: TOTAL_BYTES },
  ));
  let fail!: (error: Error) => void;
  const failed = new Promise<never>((_resolve, reject) => { fail = reject; });
  const onAbort = (): void => fail(cancelled());
  const onError = (): void => fail(new Error("Kimi authentication discovery process failed."));
  const onClose = (): void => fail(new Error("Kimi authentication discovery exited before initialization completed."));
  const onWireError = (): void => fail(new Error("Kimi authentication discovery returned malformed or excessive protocol data."));
  let stderrBytes = 0;
  const onStderr = (chunk: Buffer): void => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > TOTAL_BYTES) fail(new Error("Kimi authentication discovery exceeded its stderr limit."));
  };
  child.once("error", onError);
  child.once("close", onClose);
  child.stdin.on("error", onError);
  child.stdout.on("error", onError);
  child.stderr.on("error", onError);
  child.stderr.on("data", onStderr);
  wire.once("error", onWireError);
  child.stdout.pipe(wire);
  signal?.addEventListener("abort", onAbort, { once: true });
  const requestedTimeout = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(1, Math.min(requestedTimeout, 20_000)) : DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => fail(new Error("Kimi authentication discovery timed out.")), timeoutMs);
  timer.unref();
  let selected: ReturnType<typeof selectKimiAcpAuthMethod>;
  try {
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(wire) as ReadableStream<Uint8Array>,
    );
    const operation = acp.client({ name: "Inertia" }).connectWith(stream, async (context) => {
      const initialized = await context.request(acp.methods.agent.initialize, {
        protocolVersion: 1,
        clientInfo: { name: "Inertia", version: INERTIA_VERSION },
        clientCapabilities: { auth: { terminal: true } },
      });
      validateKimiInitialize(initialized);
      return selectKimiAcpAuthMethod(initialized.authMethods, environment);
    }).catch(() => {
      // JSON/schema/RPC failures can quote provider-authored fields. Login
      // discovery must not forward those values into notifications or logs.
      throw new Error("Kimi authentication discovery returned invalid initialization data.");
    });
    selected = await Promise.race([operation, failed]);
  } finally {
    clearTimeout(timer);
    // The exact tree must be retired even for malformed frames, cancellation,
    // or a valid descriptor. Unconfirmed cleanup overrides any usable result.
    try {
      await terminate(true);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      child.stdout.unpipe(wire);
      wire.destroy();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
  // Cancellation while awaiting the cleanup barrier cannot authorize login.
  if (signal?.aborted) throw cancelled();
  return selected;
}
