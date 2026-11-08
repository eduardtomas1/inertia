import { extname } from "node:path";

import * as acp from "@agentclientprotocol/sdk/unstable";
import type {
  ContentBlock,
  InitializeResponse,
  SessionConfigOption,
} from "@agentclientprotocol/sdk/unstable";

import { imageMediaType, readBoundedProviderImage } from "./provider-image-read";
import { acpConfigSelected, assertAcpConfigSelection } from "./acp-config-options";

const MAX_EVENT_TEXT_CHARS = 1024 * 1024;

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
  configOptions: SessionConfigOption[],
  model?: string,
  effort?: string,
  requestControl: GrokControlRequest = (request) => request,
  restored = false,
): Promise<SessionConfigOption[]> {
  let authoritativeConfigOptions = configOptions;
  const requested: Array<{ ids: string[]; categories: string[]; value: string; label: string }> = [];
  if (model && model !== "provider-default") {
    requested.push({ ids: ["model"], categories: ["model"], value: model, label: "model" });
  }
  if (effort) {
    requested.push({
      ids: ["reasoning_effort"],
      categories: ["thought_level"],
      value: effort,
      label: "reasoning effort",
    });
  }
  const selections: Array<{ id: string; value: string }> = [];
  for (const { ids, categories, value, label } of requested) {
    const selected = findAdvertisedChoice(authoritativeConfigOptions, ids, categories, value);
    if (!selected) {
      throw new Error(`Grok ACP does not advertise the selected ${label} '${bounded(value)}'.`);
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
    }
    selections.push(selected);
  }
  for (const selected of selections) {
    assertAcpConfigSelection("Grok", authoritativeConfigOptions, selected);
  }
  return authoritativeConfigOptions;
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
      "Grok did not advertise image support for this session, so the attachment cannot be sent.",
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
