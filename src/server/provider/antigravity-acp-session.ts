import { extname } from "node:path";

import * as acp from "@agentclientprotocol/sdk/unstable";
import type {
  ContentBlock,
  InitializeResponse,
  SessionConfigOption,
  SessionModeState,
} from "@agentclientprotocol/sdk/unstable";

import { clipCodeUnits } from "../../shared/code-units";
import { acpConfigSelected, assertAcpConfigSelection } from "./acp-config-options";
import { acpReadOnlyWatcher } from "./acp-watcher";
import type { ProviderRunInput } from "./contracts";
import { imageMediaType, readBoundedProviderImage } from "./provider-image-read";

const MAX_EVENT_TEXT_CHARS = 1024 * 1024;
const EFFORT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  low: ["low"],
  medium: ["medium"],
  high: ["high"],
  xhigh: ["xhigh", "extra high", "extra"],
  max: ["max"],
};

export type AntigravityControlRequest = <T>(
  request: Promise<T>,
  method: string,
) => Promise<T>;

export type AntigravitySessionModeTarget = "plan" | "default" | "accept-edits";

export function antigravityTargetMode(
  input: Pick<ProviderRunInput, "interactionMode" | "access" | "readOnlyProfile">,
): AntigravitySessionModeTarget | undefined {
  if (input.interactionMode === "plan" || acpReadOnlyWatcher(input)) return "plan";
  if (input.access === "supervised") return "default";
  if (input.access === "auto-edit") return "accept-edits";
  return undefined;
}

export async function withAntigravityRpcDeadline<T>(
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
            `Antigravity ACP ${method} RPC deadline exceeded after ${Math.max(0, timeoutMs)} ms.`,
          ));
        }, Math.max(0, timeoutMs));
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function configureAntigravitySession(
  context: acp.ClientContext,
  sessionId: string,
  modes: SessionModeState | null | undefined,
  configOptions: SessionConfigOption[],
  input: Pick<ProviderRunInput, "interactionMode" | "access" | "readOnlyProfile">,
  model?: string,
  effort?: string,
  requestControl: AntigravityControlRequest = (request) => request,
  restored = false,
): Promise<SessionConfigOption[]> {
  let authoritativeConfigOptions = configOptions;
  const requestedSelections: Array<{ id: string; value: string }> = [];

  const targetMode = antigravityTargetMode(input)
    ?? (modes?.currentModeId === "plan" ? "default" : undefined);
  if (targetMode) {
    const nativeMode = modes?.availableModes.find((mode) =>
      mode.id.toLowerCase() === targetMode,
    );
    const configMode = findAdvertisedChoice(
      authoritativeConfigOptions,
      ["mode"],
      ["mode"],
      targetMode,
    );
    if (nativeMode) {
      // Always apply mode explicitly when advertised: agy 1.5.7+ defaults to
      // `auto`, so supervised ("default"), auto-edit ("accept-edits"), and
      // plan ("plan") must never rely on the server's implicit default.
      await requestControl(
        context.request(acp.methods.agent.session.setMode, {
          sessionId,
          modeId: nativeMode.id,
        }),
        "session/set_mode",
      ).catch((error: unknown) => {
        if (!antigravityModeAlreadySelected(error, nativeMode.id)) throw error;
      });
    } else if (configMode) {
      const response = await requestControl(
        context.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId: configMode.id,
          value: configMode.value,
        }),
        "session/set_config_option",
      );
      authoritativeConfigOptions = response.configOptions;
      assertAcpConfigSelection("Antigravity", authoritativeConfigOptions, configMode);
      requestedSelections.push(configMode);
    } else if (modes?.currentModeId?.toLowerCase() !== targetMode) {
      throw new Error(
        `This Antigravity ACP server does not advertise the required '${targetMode}' mode.`,
      );
    }
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
        `Antigravity ACP does not advertise the selected model '${bounded(model)}'.`,
      );
    }
    if (restored || !acpConfigSelected(authoritativeConfigOptions, selected)) {
      const response = await requestControl(
        context.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId: selected.id,
          value: selected.value,
        }),
        "session/set_config_option",
      );
      authoritativeConfigOptions = response.configOptions;
      assertAcpConfigSelection("Antigravity", authoritativeConfigOptions, selected);
    }
    requestedSelections.push(selected);
  }

  const trimmedEffort = effort?.trim();
  if (trimmedEffort) {
    const effortOption = findSelectOption(
      authoritativeConfigOptions,
      ["thought_level", "thinking_level", "reasoning_effort"],
      ["thought_level"],
    );
    const effortChoices = effortOption ? selectChoices(effortOption) : [];
    // Fixed-effort models (e.g. Orchestrator) omit thought_level or expose a
    // single non-adjustable entry; skip thought_level instead of failing.
    if (effortOption && effortChoices.length > 1) {
      const selected = matchEffortChoice(effortOption.id, effortChoices, trimmedEffort);
      if (!selected) {
        throw new Error(
          `Antigravity ACP does not advertise the selected reasoning effort '${bounded(trimmedEffort)}'.`,
        );
      }
      if (restored || !acpConfigSelected(authoritativeConfigOptions, selected)) {
        const response = await requestControl(
          context.request(acp.methods.agent.session.setConfigOption, {
            sessionId,
            configId: selected.id,
            value: selected.value,
          }),
          "session/set_config_option",
        );
        authoritativeConfigOptions = response.configOptions;
        assertAcpConfigSelection("Antigravity", authoritativeConfigOptions, selected);
      }
      requestedSelections.push(selected);
    }
  }

  for (const selected of requestedSelections) {
    assertAcpConfigSelection("Antigravity", authoritativeConfigOptions, selected);
  }
  return authoritativeConfigOptions;
}

function antigravityModeAlreadySelected(error: unknown, expectedModeId: string): boolean {
  if (!(error instanceof acp.RequestError) || error.code !== -32603) return false;
  const details = (error.data as { details?: unknown } | null | undefined)?.details;
  const text = typeof details === "string" ? details : error.message;
  const match = /^already in ([\w-]+) mode$/iu.exec(text.trim());
  return match?.[1]?.toLowerCase() === expectedModeId.toLowerCase();
}

function findSelectOption(
  configOptions: SessionConfigOption[],
  ids: readonly string[],
  categories: readonly string[],
): SessionConfigOption | undefined {
  const selects = configOptions.filter((option) => option.type === "select");
  return selects.find((candidate) =>
    candidate.category != null && categories.includes(candidate.category),
  ) ?? selects.find((candidate) => ids.includes(candidate.id));
}

function findAdvertisedChoice(
  configOptions: SessionConfigOption[],
  ids: readonly string[],
  categories: readonly string[],
  wanted: string,
): { id: string; value: string } | undefined {
  const option = findSelectOption(configOptions, ids, categories);
  if (!option || option.type !== "select") return undefined;
  const wantedLower = wanted.toLowerCase();
  const selected = selectChoices(option).find((choice) =>
    choice.value.toLowerCase() === wantedLower
    || choice.name.toLowerCase() === wantedLower,
  );
  return selected ? { id: option.id, value: selected.value } : undefined;
}

function matchEffortChoice(
  optionId: string,
  choices: ReadonlyArray<{ value: string; name: string }>,
  wanted: string,
): { id: string; value: string } | undefined {
  const wantedLower = wanted.toLowerCase();
  const aliases = EFFORT_ALIASES[wantedLower] ?? [wantedLower];
  const selected = choices.find((choice) => {
    const valueLower = choice.value.toLowerCase();
    const nameLower = choice.name.toLowerCase();
    return aliases.includes(valueLower) || aliases.includes(nameLower);
  });
  return selected ? { id: optionId, value: selected.value } : undefined;
}

function selectChoices(
  option: SessionConfigOption,
): Array<{ value: string; name: string }> {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) => "options" in entry ? entry.options : [entry]);
}

function supportsImageCapability(initializedOrSupported: boolean | InitializeResponse): boolean {
  if (typeof initializedOrSupported === "boolean") return initializedOrSupported;
  const caps = initializedOrSupported.agentCapabilities as Record<string, unknown> | undefined;
  const promptCaps = (caps?.promptCapabilities ?? caps?.prompt_capabilities) as
    | Record<string, unknown>
    | undefined;
  return promptCaps?.image === true;
}

export async function antigravityPrompt(
  prompt: string,
  paths: readonly string[],
  supportsImages: boolean | InitializeResponse,
  signal?: AbortSignal,
): Promise<ContentBlock[]> {
  if (paths.length > 0 && !supportsImageCapability(supportsImages)) {
    throw new Error(
      "Antigravity did not advertise image support for this session, so the attachment cannot be sent.",
    );
  }
  const blocks: ContentBlock[] = [];
  let total = 0;
  for (const path of paths) {
    const mimeType = imageMediaType(path);
    if (!mimeType) {
      throw new Error(
        `Antigravity does not support the attached image type: ${extname(path) || "unknown"}.`,
      );
    }
    const data = await readBoundedProviderImage("Antigravity", path, total, signal);
    total += data.byteLength;
    blocks.push({ type: "image", mimeType, data: data.toString("base64") });
  }
  blocks.push({ type: "text", text: prompt });
  return blocks;
}

function bounded(value: string): string {
  return clipCodeUnits(value, MAX_EVENT_TEXT_CHARS);
}
