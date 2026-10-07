import { extname } from "node:path";

import * as acp from "@agentclientprotocol/sdk";
import type {
  ContentBlock,
  InitializeResponse,
  SessionConfigOption,
  SessionModeState,
} from "@agentclientprotocol/sdk";

import { imageMediaType, readBoundedProviderImage } from "./provider-image-read";
import { assertAcpConfigSelection } from "./acp-config-options";

const MAX_EVENT_TEXT_CHARS = 1024 * 1024;

export type KimiControlRequest = <T>(
  request: Promise<T>,
  method: string,
) => Promise<T>;

export async function withKimiRpcDeadline<T>(
  request: Promise<T>,
  timeoutMs: number,
  method: string,
  onTimeout: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(
            `Kimi ACP ${method} RPC deadline exceeded after ${Math.max(0, timeoutMs)} ms.`,
          ));
        }, Math.max(0, timeoutMs));
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function configureKimiSession(
  context: acp.ClientContext,
  sessionId: string,
  modes: SessionModeState | null | undefined,
  configOptions: SessionConfigOption[],
  interactionMode: "build" | "plan",
  model?: string,
  effort?: string,
  requestControl: KimiControlRequest = (request) => request,
  restored = false,
): Promise<SessionConfigOption[]> {
  let authoritativeConfigOptions = configOptions;
  const requestedSelections: Array<{ id: string; value: string }> = [];
  const wantedMode = interactionMode === "plan"
    ? /plan|architect/iu
    : /build|agent|code|default/iu;
  const nativeMode = modes?.availableModes.find((mode) =>
    wantedMode.test(`${mode.id} ${mode.name}`),
  );
  const configMode = findKimiAdvertisedConfigValue(
    authoritativeConfigOptions,
    "mode",
    interactionMode === "plan" ? "plan" : "build",
    wantedMode,
  );
  const restoredModeUnverified = restored && (modes?.availableModes.length ?? 0) > 1;
  if (nativeMode && (restoredModeUnverified || modes?.currentModeId !== nativeMode.id)) {
    await requestControl(
      context.request(acp.methods.agent.session.setMode, {
        sessionId,
        modeId: nativeMode.id,
      }),
      "session/set_mode",
    ).catch((error: unknown) => {
      if (!kimiModeAlreadySelected(error)) throw error;
    });
  } else if (!nativeMode && configMode) {
    const response = await requestControl(
      context.request(
        acp.methods.agent.session.setConfigOption,
        { sessionId, configId: configMode.id, value: configMode.value },
      ),
      "session/set_config_option",
    );
    authoritativeConfigOptions = response.configOptions;
    assertAcpConfigSelection("Kimi", authoritativeConfigOptions, configMode);
    requestedSelections.push(configMode);
  } else if (!nativeMode && interactionMode === "plan") {
    throw new Error("This Kimi ACP server does not advertise a plan mode.");
  }

  if (model && model !== "provider-default") {
    const selected = findKimiAdvertisedConfigValue(
      authoritativeConfigOptions,
      "model",
      model,
    );
    if (!selected) {
      throw new Error(
        `Kimi ACP does not advertise the selected model '${bounded(model)}'.`,
      );
    }
    const response = await requestControl(
      context.request(
        acp.methods.agent.session.setConfigOption,
        { sessionId, configId: selected.id, value: selected.value },
      ),
      "session/set_config_option",
    );
    authoritativeConfigOptions = response.configOptions;
    assertAcpConfigSelection("Kimi", authoritativeConfigOptions, selected);
    requestedSelections.push(selected);
  }
  if (effort) {
    const selected = findKimiAdvertisedConfigValue(
      authoritativeConfigOptions,
      "thought_level",
      effort,
    );
    if (!selected) {
      throw new Error(
        `Kimi ACP does not advertise the selected reasoning effort '${bounded(effort)}'.`,
      );
    }
    const response = await requestControl(
      context.request(
        acp.methods.agent.session.setConfigOption,
        { sessionId, configId: selected.id, value: selected.value },
      ),
      "session/set_config_option",
    );
    authoritativeConfigOptions = response.configOptions;
    assertAcpConfigSelection("Kimi", authoritativeConfigOptions, selected);
    requestedSelections.push(selected);
  }
  for (const selected of requestedSelections) {
    assertAcpConfigSelection("Kimi", authoritativeConfigOptions, selected);
  }
  return authoritativeConfigOptions;
}

function kimiModeAlreadySelected(error: unknown): boolean {
  if (!(error instanceof acp.RequestError) || error.code !== -32603) return false;
  const details = (error.data as { details?: unknown } | null | undefined)?.details;
  return typeof details === "string" && /^already in [\w-]+ mode$/iu.test(details.trim());
}

export function findKimiAdvertisedConfigValue(
  configOptions: SessionConfigOption[],
  category: string,
  wanted: string,
  fallbackPattern?: RegExp,
): { id: string; value: string } | undefined {
  const option = configOptions.find((candidate) =>
    candidate.type === "select" && candidate.category === category,
  );
  if (!option || option.type !== "select") return undefined;
  const choices = option.options.flatMap((entry) =>
    "options" in entry ? entry.options : [entry],
  );
  const wantedLower = wanted.toLowerCase();
  const selected = choices.find((choice) =>
    choice.value.toLowerCase() === wantedLower
    || choice.name.toLowerCase() === wantedLower,
  ) ?? (fallbackPattern
    ? choices.find((choice) =>
      fallbackPattern.test(`${choice.value} ${choice.name}`),
    )
    : undefined);
  return selected ? { id: option.id, value: selected.value } : undefined;
}

export async function kimiPrompt(
  prompt: string,
  paths: readonly string[],
  initialized: InitializeResponse,
  signal?: AbortSignal,
): Promise<ContentBlock[]> {
  if (
    paths.length > 0
    && initialized.agentCapabilities?.promptCapabilities?.image !== true
  ) {
    throw new Error(
      "This Kimi ACP server did not advertise image prompt support.",
    );
  }
  const blocks: ContentBlock[] = [];
  let total = 0;
  for (const path of paths) {
    const mimeType = imageMediaType(path);
    if (!mimeType) {
      throw new Error(
        `Kimi Code does not support the attached image type: ${extname(path) || "unknown"}.`,
      );
    }
    const data = await readBoundedProviderImage("Kimi Code", path, total, signal);
    total += data.byteLength;
    blocks.push({ type: "image", mimeType, data: data.toString("base64") });
  }
  blocks.push({ type: "text", text: prompt });
  return blocks;
}

function bounded(value: string): string {
  return value.slice(0, MAX_EVENT_TEXT_CHARS);
}
