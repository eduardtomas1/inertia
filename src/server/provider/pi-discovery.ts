import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { objectValue } from "../codex/protocol";
import { credentialFreeProviderEnvironment } from "../environment";
import { openPiRpcConnection, type PiRpcOptions } from "./pi-rpc";
import { providerUnconfirmedCleanup } from "./provider-unconfirmed-cleanup";

export type PiProtocolProbe = (options: Pick<PiRpcOptions, "executable" | "environment" | "cwd" | "signal" | "timeoutMs" | "terminateProcessTree">) => Promise<{ ready: boolean; cleanupConfirmed: boolean }>;

/** Secret-free capability probe. Never reads the user's native auth/configuration. */
export const probePiProtocol: PiProtocolProbe = async (options) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "inertia-pi-probe-"));
  let connection: ReturnType<typeof openPiRpcConnection> | undefined;
  let ready = false; let cleanupConfirmed = true;
  try {
    connection = openPiRpcConnection({ ...options,
      environment: { ...credentialFreeProviderEnvironment(options.environment), PI_CODING_AGENT_DIR: directory },
      args: ["--mode", "rpc", "--no-session", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-tools", "--offline"],
    });
    const state = objectValue(await connection.request("get_state"));
    const levels = objectValue(await connection.request("get_available_thinking_levels"));
    ready = state?.isStreaming === false && state.isCompacting === false && Array.isArray(levels?.levels);
  } catch { ready = false; }
  finally {
    try { await connection?.close(); } catch { cleanupConfirmed = false; }
    if (cleanupConfirmed) await rm(directory, { recursive: true, force: true });
    else if (connection) void providerUnconfirmedCleanup(connection.child).cleanupConfirmation.then(async (confirmed) => {
      if (confirmed) await rm(directory, { recursive: true, force: true });
    }).catch(() => undefined);
  }
  return { ready, cleanupConfirmed };
};
