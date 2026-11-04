import { extname } from "node:path";

import * as acp from "@agentclientprotocol/sdk/unstable";
import type {
  ContentBlock,
  InitializeResponse,
  SessionConfigOption,
  SessionModeState,
} from "@agentclientprotocol/sdk/unstable";

import { imageMediaType, readBoundedProviderImage } from "./provider-image-read";
import { acpConfigSelected, assertAcpConfigSelection } from "./acp-config-options";
import type { ProviderAccessMode } from "./contracts";

const MAX_EVENT_TEXT_CHARS = 1024 * 1024;
const ACCEPT_EDITS = /^accept[-_ ]?edits?$/iu;
const BUILD_MODE = /^(?:build|agent|code|default)$/iu;

export type GrokControlRequest = <T>(
  request: Promise<T>,
  method: string,
) => Promise<T>;

export async function withGrokRpcDeadline<T>(
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
            `Grok ACP ${method} RPC deadline exceeded after ${Math.max(0, timeoutMs)} ms.`,
          ));
        }, Math.max(0, timeoutMs));
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function configureGrokSession(
  context: acp.ClientContext,
  sessionId: string,
  modes: SessionModeState | null | undefined,
  configOptions: SessionConfigOption[],
  interactionMode: "build" | "plan",
  access: ProviderAccessMode,
  model?: string,
  effort?: string,
  requestControl: GrokControlRequest = (request) => request,
  restored = false,
): Promise<SessionConfigOption[]> {
  let authoritativeConfigOptions = configOptions;
  const requestedSelections: Array<{ id: string; value: string }> = [];
  if (interactionMode === "plan") {
    authoritativeConfigOptions = await selectPlanMode(
      context,
      sessionId,
      modes,
      authoritativeConfigOptions,
      requestControl,
    );
  } else if (access === "auto-edit") {
    authoritativeConfigOptions = await selectAcceptEdits(
      context,
      sessionId,
      modes,
      authoritativeConfigOptions,
      requestControl,
    );
  } else {
    await leavePlanMode(context, sessionId, modes, requestControl);
  }

  if (model && model !== "provider-default") {
    const selected = findAdvertisedChoice(
      authoritativeConfigOptions,
      ["model"],
      ["model"],
      model,
    );
    if (!selected) {
      throw new Error(
        `Grok ACP does not advertise the selected model '${bounded(model)}'.`,
      );
    }
    if (restored || !acpConfigSelected(authoritativeConfigOptions, selected)) {
      const response = await requestControl(
        context.request(
          acp.methods.agent.session.setConfigOption,
          { sessionId, configId: selected.id, value: selected.value },
        ),
        "session/set_config_option",
      );
      authoritativeConfigOptions = response.configOptions;
      assertAcpConfigSelection("Grok", authoritativeConfigOptions, selected);
    }
    requestedSelections.push(selected);
  }
  if (effort) {
    const selected = findAdvertisedChoice(
      authoritativeConfigOptions,
      ["reasoning_effort"],
      ["thought_level"],
      effort,
    );
    if (!selected) {
      throw new Error(
        `Grok ACP does not advertise the selected reasoning effort '${bounded(effort)}'.`,
      );
    }
    if (restored || !acpConfigSelected(authoritativeConfigOptions, selected)) {
      const response = await requestControl(
        context.request(
          acp.methods.agent.session.setConfigOption,
          { sessionId, configId: selected.id, value: selected.value },
        ),
        "session/set_config_option",
      );
      authoritativeConfigOptions = response.configOptions;
      assertAcpConfigSelection("Grok", authoritativeConfigOptions, selected);
    }
    requestedSelections.push(selected);
  }
  for (const selected of requestedSelections) {
    assertAcpConfigSelection("Grok", authoritativeConfigOptions, selected);
  }
  return authoritativeConfigOptions;
}

async function selectPlanMode(
  context: acp.ClientContext,
  sessionId: string,
  modes: SessionModeState | null | undefined,
  configOptions: SessionConfigOption[],
  requestControl: GrokControlRequest,
): Promise<SessionConfigOption[]> {
  const nativeMode = modes?.availableModes.find((mode) =>
    mode.id.toLowerCase() === "plan" || mode.name.toLowerCase() === "plan",
  );
  if (nativeMode) {
    if (modes?.currentModeId !== nativeMode.id) {
      await requestControl(
        context.request(acp.methods.agent.session.setMode, {
          sessionId,
          modeId: nativeMode.id,
        }),
        "session/set_mode",
      ).catch((error: unknown) => {
        if (!grokModeAlreadySelected(error)) throw error;
      });
    }
    return configOptions;
  }
  const configMode = findPlanConfig(configOptions);
  if (!configMode) {
    throw new Error("This Grok ACP server does not advertise a plan mode.");
  }
  const response = await requestControl(
    context.request(
      acp.methods.agent.session.setConfigOption,
      { sessionId, configId: configMode.id, value: configMode.value },
    ),
    "session/set_config_option",
  );
  assertAcpConfigSelection("Grok", response.configOptions, configMode);
  return response.configOptions;
}

async function selectAcceptEdits(
  context: acp.ClientContext,
  sessionId: string,
  modes: SessionModeState | null | undefined,
  configOptions: SessionConfigOption[],
  requestControl: GrokControlRequest,
): Promise<SessionConfigOption[]> {
  const nativeMode = modes?.availableModes.find((mode) =>
    ACCEPT_EDITS.test(mode.id) || ACCEPT_EDITS.test(mode.name),
  );
  if (nativeMode) {
    if (modes?.currentModeId !== nativeMode.id) {
      await requestControl(
        context.request(acp.methods.agent.session.setMode, {
          sessionId,
          modeId: nativeMode.id,
        }),
        "session/set_mode",
      ).catch((error: unknown) => {
        if (!grokModeAlreadySelected(error)) throw error;
      });
    }
    return configOptions;
  }
  const configMode = findAcceptEditsConfig(configOptions);
  if (!configMode) return configOptions;
  if (acpConfigSelected(configOptions, configMode)) return configOptions;
  const response = await requestControl(
    context.request(
      acp.methods.agent.session.setConfigOption,
      { sessionId, configId: configMode.id, value: configMode.value },
    ),
    "session/set_config_option",
  );
  assertAcpConfigSelection("Grok", response.configOptions, configMode);
  return response.configOptions;
}

async function leavePlanMode(
  context: acp.ClientContext,
  sessionId: string,
  modes: SessionModeState | null | undefined,
  requestControl: GrokControlRequest,
): Promise<void> {
  if (!isPlanId(modes?.currentModeId)) return;
  const available = modes?.availableModes ?? [];
  const nativeMode = available.find((mode) =>
    BUILD_MODE.test(mode.id) || BUILD_MODE.test(mode.name),
  ) ?? available.find((mode) =>
    !isPlanId(mode.id) && !isPlanId(mode.name),
  );
  if (!nativeMode || nativeMode.id === modes?.currentModeId) return;
  await requestControl(
    context.request(acp.methods.agent.session.setMode, {
      sessionId,
      modeId: nativeMode.id,
    }),
    "session/set_mode",
  ).catch((error: unknown) => {
    if (!grokModeAlreadySelected(error)) throw error;
  });
}

function isPlanId(value: string | null | undefined): boolean {
  return value?.toLowerCase() === "plan";
}

function grokModeAlreadySelected(error: unknown): boolean {
  if (!(error instanceof acp.RequestError) || error.code !== -32603) return false;
  const details = (error.data as { details?: unknown } | null | undefined)?.details;
  return typeof details === "string" && /^already in [\w-]+ mode$/iu.test(details.trim());
}

function findPlanConfig(
  configOptions: SessionConfigOption[],
): { id: string; value: string } | undefined {
  const selects = configOptions.filter((option) => option.type === "select");
  const ordered = [
    ...selects.filter((option) => option.id === "mode"),
    ...selects.filter((option) => option.category === "mode" && option.id !== "mode"),
    ...selects.filter((option) =>
      option.id !== "mode"
      && option.category !== "mode"
      && /mode|permission/iu.test(option.id),
    ),
  ];
  for (const option of ordered) {
    const selected = selectChoices(option).find((choice) =>
      choice.value.toLowerCase() === "plan" || choice.name.toLowerCase() === "plan",
    );
    if (selected) return { id: option.id, value: selected.value };
  }
  return undefined;
}

function findAcceptEditsConfig(
  configOptions: SessionConfigOption[],
): { id: string; value: string } | undefined {
  for (const option of configOptions) {
    if (option.type !== "select") continue;
    const selected = selectChoices(option).find((choice) =>
      ACCEPT_EDITS.test(choice.value) || ACCEPT_EDITS.test(choice.name),
    );
    if (selected) return { id: option.id, value: selected.value };
  }
  return undefined;
}

function findAdvertisedChoice(
  configOptions: SessionConfigOption[],
  ids: readonly string[],
  categories: readonly string[],
  wanted: string,
): { id: string; value: string } | undefined {
  const selects = configOptions.filter((option) => option.type === "select");
  const option = selects.find((candidate) => ids.includes(candidate.id))
    ?? selects.find((candidate) =>
      candidate.category != null && categories.includes(candidate.category),
    );
  if (!option || option.type !== "select") return undefined;
  const wantedLower = wanted.toLowerCase();
  const selected = selectChoices(option).find((choice) =>
    choice.value.toLowerCase() === wantedLower
    || choice.name.toLowerCase() === wantedLower,
  );
  return selected ? { id: option.id, value: selected.value } : undefined;
}

function selectChoices(
  option: SessionConfigOption,
): Array<{ value: string; name: string }> {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) => "options" in entry ? entry.options : [entry]);
}

export async function grokPrompt(
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
      "This Grok ACP server did not advertise image prompt support.",
    );
  }
  const blocks: ContentBlock[] = [];
  let total = 0;
  for (const path of paths) {
    const mimeType = imageMediaType(path);
    if (!mimeType) {
      throw new Error(
        `Grok does not support the attached image type: ${extname(path) || "unknown"}.`,
      );
    }
    const data = await readBoundedProviderImage("Grok", path, total, signal);
    total += data.byteLength;
    blocks.push({ type: "image", mimeType, data: data.toString("base64") });
  }
  blocks.push({ type: "text", text: prompt });
  return blocks;
}

function bounded(value: string): string {
  return value.slice(0, MAX_EVENT_TEXT_CHARS);
}
