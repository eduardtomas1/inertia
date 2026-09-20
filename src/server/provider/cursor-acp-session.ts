import * as acp from "@agentclientprotocol/sdk";
import type { SessionConfigOption, SessionModeState } from "@agentclientprotocol/sdk";

import { assertAcpConfigSelection } from "./acp-config-options";

export async function configureCursorSession(
  context: acp.ClientContext,
  sessionId: string,
  modes: SessionModeState | null | undefined,
  configOptions: SessionConfigOption[],
  interactionMode: "build" | "plan",
  model?: string,
  effort?: string,
  redactResponse: <T>(value: T) => T = (value) => value,
  requestControl: <T>(request: Promise<T>, method: string) => Promise<T> = (request) => request,
): Promise<SessionConfigOption[]> {
  let authoritativeConfigOptions = configOptions;
  const requestedSelections: Array<{ id: string; value: string }> = [];
  const wantedMode = interactionMode === "plan" ? /plan|architect/iu : /build|agent|code/iu;
  const nativeMode = modes?.availableModes.find((mode) => wantedMode.test(`${mode.id} ${mode.name}`));
  const configMode = findCursorAdvertisedConfigValue(authoritativeConfigOptions, "mode", interactionMode === "plan" ? "plan" : "build", wantedMode);
  if (nativeMode && modes?.currentModeId !== nativeMode.id) {
    await requestControl(
      context.request(acp.methods.agent.session.setMode, { sessionId, modeId: nativeMode.id }),
      "session/set_mode",
    );
  } else if (!nativeMode && configMode) {
    const response = redactResponse(await requestControl(context.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: configMode.id, value: configMode.value }), "session/set_config_option"));
    authoritativeConfigOptions = response.configOptions;
    assertAcpConfigSelection("Cursor", authoritativeConfigOptions, configMode);
    requestedSelections.push(configMode);
  } else if (interactionMode === "plan" && !nativeMode) {
    throw new Error("This Cursor ACP server does not advertise a plan mode.");
  }
  if (model) {
    const selected = findCursorAdvertisedConfigValue(authoritativeConfigOptions, "model", model);
    if (!selected) throw new Error(`Cursor ACP does not advertise the selected model '${model}'.`);
    const response = redactResponse(await requestControl(context.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: selected.id, value: selected.value }), "session/set_config_option"));
    authoritativeConfigOptions = response.configOptions;
    assertAcpConfigSelection("Cursor", authoritativeConfigOptions, selected);
    requestedSelections.push(selected);
  }
  if (effort) {
    const selected = findCursorAdvertisedConfigValue(authoritativeConfigOptions, "thought_level", effort);
    if (!selected) throw new Error(`Cursor ACP does not advertise the selected reasoning effort '${effort}'.`);
    const response = redactResponse(await requestControl(context.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: selected.id, value: selected.value }), "session/set_config_option"));
    authoritativeConfigOptions = response.configOptions;
    assertAcpConfigSelection("Cursor", authoritativeConfigOptions, selected);
    requestedSelections.push(selected);
  }
  for (const selected of requestedSelections) {
    assertAcpConfigSelection("Cursor", authoritativeConfigOptions, selected);
  }
  return authoritativeConfigOptions;
}

export function findCursorAdvertisedConfigValue(
  configOptions: SessionConfigOption[],
  category: string,
  wanted: string,
  fallbackPattern?: RegExp,
): { id: string; value: string } | undefined {
  const option = configOptions.find((candidate) => candidate.type === "select" && candidate.category === category);
  if (!option || option.type !== "select") return undefined;
  const choices = option.options.flatMap((entry) => "options" in entry ? entry.options : [entry]);
  const wantedLower = wanted.toLowerCase();
  const selected = choices.find((choice) => choice.value.toLowerCase() === wantedLower || choice.name.toLowerCase() === wantedLower)
    ?? (fallbackPattern ? choices.find((choice) => fallbackPattern.test(`${choice.value} ${choice.name}`)) : undefined);
  return selected ? { id: option.id, value: selected.value } : undefined;
}
