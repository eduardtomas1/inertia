import type { Provider } from "@opencode-ai/sdk/v2";

import type { ProviderModel } from "../../shared/contracts";
import {
  terminateProcessTreeAndWait,
  type ProcessTreeTerminator,
} from "../process-lifecycle";
import {
  createOwnedOpenCodeClient,
  ownedOpenCodeCredentials,
  ownedOpenCodeEnvironment,
} from "./opencode-boundary";
import { CappedProviderBuffer } from "./io";
import {
  startOwnedOpenCodeServer,
  waitForOpenCodeHealth,
  withOpenCodeRequestDeadline,
} from "./opencode-owned-server";

const START_TIMEOUT_MS = 10_000;
const METADATA_PROVIDER_TIMEOUT_MS = 10_000;
const MAX_SERVER_OUTPUT_CHARS = 32 * 1024;
const MIN_DEADLINE_MS = 25;

export interface OpenCodeSdkMetadataOptions {
  /** May shorten, but never extend, the production health-check deadline. */
  healthTimeoutMs?: number;
  /** May shorten, but never extend, the production provider-catalog deadline. */
  providerTimeoutMs?: number;
  terminateProcessTree?: ProcessTreeTerminator;
  /** Cancels metadata IO and resolves only after the owned server is stopped. */
  signal?: AbortSignal;
}

function shortenedTimeout(
  value: number | undefined,
  maximum: number,
  name: string,
): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`OpenCode ${name} must be a positive integer.`);
  }
  return Math.max(MIN_DEADLINE_MS, Math.min(value, maximum));
}

export function openCodeModels(
  providers: Provider[],
  defaults: Record<string, string>,
  connectedProviderIds: readonly string[],
): ProviderModel[] {
  const connected = new Set(connectedProviderIds);
  return providers.filter((provider) => connected.has(provider.id)).flatMap((provider) => Object.values(provider.models).map((model) => {
    const variants = Object.keys(model.variants ?? {});
    return {
      id: `${provider.id}/${model.id}`,
      label: model.name || model.id,
      description: [provider.name, model.family, model.status !== "active" ? model.status : undefined].filter(Boolean).join(" · ") || "OpenCode model",
      isDefault: defaults[provider.id] === model.id,
      inputModalities: model.capabilities.input.image ? ["text", "image"] : ["text"],
      reasoningOptions: variants.map((variant) => ({ value: variant, label: variant, description: `${variant} model variant` })),
      // Catalog variants are explicit overlays; their record order does not
      // identify the base model's effective default.
      defaultReasoningEffort: "",
    } satisfies ProviderModel;
  })).slice(0, 128);
}

export async function readOpenCodeSdkModels(
  executable: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  options: OpenCodeSdkMetadataOptions = {},
): Promise<ProviderModel[]> {
  if (options.signal?.aborted) {
    throw new Error("OpenCode metadata discovery was cancelled.");
  }
  const healthTimeoutMs = shortenedTimeout(
    options.healthTimeoutMs,
    START_TIMEOUT_MS,
    "metadata healthTimeoutMs",
  );
  const providerTimeoutMs = shortenedTimeout(
    options.providerTimeoutMs,
    METADATA_PROVIDER_TIMEOUT_MS,
    "metadata providerTimeoutMs",
  );
  const terminateOwnedProcessTree = options.terminateProcessTree
    ?? terminateProcessTreeAndWait;
  const output = new CappedProviderBuffer(MAX_SERVER_OUTPUT_CHARS);
  const credentials = ownedOpenCodeCredentials(environment);
  const started = await startOwnedOpenCodeServer(
    executable,
    cwd,
    ownedOpenCodeEnvironment(environment, credentials),
    output,
    terminateOwnedProcessTree,
    "OpenCode metadata server process tree",
    options.signal,
  );
  const client = createOwnedOpenCodeClient(started.url, cwd, credentials);
  try {
    await waitForOpenCodeHealth(
      client,
      started.child,
      healthTimeoutMs,
      options.signal,
    );
    const response = await withOpenCodeRequestDeadline(
      providerTimeoutMs,
      "Timed out waiting for the OpenCode provider catalog.",
      async (signal) => await client.provider.list(
        { directory: cwd },
        { signal, throwOnError: true },
      ),
      options.signal,
    );
    return openCodeModels(
      response.data.all,
      response.data.default,
      response.data.connected,
    );
  } finally {
    await started.terminate(true);
  }
}
