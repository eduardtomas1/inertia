import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import * as acp from "@agentclientprotocol/sdk";
import type {
  ContentBlock,
  InitializeResponse,
  SessionConfigOption,
  SessionModeState,
} from "@agentclientprotocol/sdk";

const MAX_EVENT_TEXT_CHARS = 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_COMPACTION_INSTRUCTION_CHARS = 4_000;

export type KimiControlRequest = <T>(
  request: Promise<T>,
  method: string,
) => Promise<T>;

export async function waitForKimiCommandAdvertisement(
  advertisement: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      advertisement,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
): Promise<SessionConfigOption[]> {
  let authoritativeConfigOptions = configOptions;
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
  if (nativeMode && modes?.currentModeId !== nativeMode.id) {
    await requestControl(
      context.request(acp.methods.agent.session.setMode, {
        sessionId,
        modeId: nativeMode.id,
      }),
      "session/set_mode",
    );
  } else if (!nativeMode && configMode) {
    const response = await requestControl(
      context.request(
        acp.methods.agent.session.setConfigOption,
        { sessionId, configId: configMode.id, value: configMode.value },
      ),
      "session/set_config_option",
    );
    authoritativeConfigOptions = response.configOptions;
  } else if (interactionMode === "plan") {
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
  }
  return authoritativeConfigOptions;
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
    const data = await readFile(path);
    total += data.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      throw new Error("Kimi Code image attachments exceed the 20 MB safety limit.");
    }
    blocks.push({ type: "image", mimeType, data: data.toString("base64") });
  }
  blocks.push({ type: "text", text: prompt });
  return blocks;
}

export function kimiCompactCommand(instruction: string | undefined): string {
  const focus = instruction?.trim();
  if (!focus) return "/compact";
  if (
    focus.length > MAX_COMPACTION_INSTRUCTION_CHARS
    || focus.includes("\0")
  ) throw new Error("Kimi Code received an invalid compaction focus instruction.");
  return `/compact ${focus}`;
}

function imageMediaType(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: return undefined;
  }
}

function bounded(value: string): string {
  return value.slice(0, MAX_EVENT_TEXT_CHARS);
}
