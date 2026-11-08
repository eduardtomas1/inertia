import type { ProviderModel } from "../../shared/contracts";
import { objectValue } from "../codex/protocol";
import { isOwnAttachmentPath } from "./attachment-read-grant";
import type { AgentHarnessStartOptions } from "./agent-harness";
import type { ProviderUsageEvent } from "./contracts";
import { openCode2Data } from "./opencode2-history";
import { imageMediaType, MAX_PROVIDER_REQUEST_IMAGE_COUNT, readBoundedProviderImage } from "./provider-image-read";

export function openCode2Models(value: unknown, defaultModel?: unknown): ProviderModel[] {
  const models = openCode2Data(value); const selected = objectValue(defaultModel);
  if (!Array.isArray(models) || models.length > 2000) throw new Error("Invalid OpenCode 2 model catalog.");
  const seen = new Set<string>();
  return models.flatMap((raw): ProviderModel[] => {
    const model = objectValue(raw);
    if (!model || typeof model.providerID !== "string" || model.providerID.includes("/") || !safeId(model.providerID)
      || !safeId(model.id) || !Array.isArray(model.variants) || model.variants.length > 64) throw new Error("Invalid OpenCode 2 model identity.");
    const id = `${model.providerID}/${model.id}`;
    if (id.length > 512 || seen.has(id)) throw new Error("Invalid OpenCode 2 model identity."); seen.add(id);
    const variants = model.variants.map((rawVariant) => {
      const variant = objectValue(rawVariant); if (!safeId(variant?.id)) throw new Error("Invalid OpenCode 2 model variant.");
      return { value: variant.id, label: variant.id, description: "Model variant" };
    });
    if (model.enabled !== true) return [];
    return [{ id, label: typeof model.name === "string" ? model.name.slice(0, 200) : id, description: `OpenCode 2 · ${model.providerID}`,
      isDefault: selected?.providerID === model.providerID && selected.id === model.id,
      inputModalities: Array.isArray(objectValue(model.capabilities)?.input) && (objectValue(model.capabilities)!.input as unknown[]).includes("image") ? ["text", "image"] : ["text"],
      reasoningOptions: variants, defaultReasoningEffort: "", reasoningObserved: true }];
  });
}
function safeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 400 && !/[\u0000-\u0020\u007f#]/u.test(value);
}

export function openCode2Selection(modelId: string, variant: string | undefined, models: ProviderModel[]) {
  const model = models.find((entry) => entry.id === modelId);
  if (!model || variant && !model.reasoningOptions.some((entry) => entry.value === variant)) throw new Error("The selected OpenCode 2 model or variant is unavailable.");
  const slash = model.id.indexOf("/");
  return { providerID: model.id.slice(0, slash), id: model.id.slice(slash + 1), ...(variant ? { variant } : {}) };
}

export function openCode2Permissions(options: AgentHarnessStartOptions, hostName?: string) {
  const readonly = options.input.interactionMode === "plan" || options.input.readOnlyProfile !== undefined;
  const enabled = options.providerNativeToolsAvailable;
  const rules: { action: string; resource: string; effect: "allow" | "ask" | "deny" }[] = [
    { action: "*", resource: "*", effect: !enabled || readonly ? "deny" : options.input.access === "full" ? "allow" : "ask" },
  ];
  if (enabled) {
    for (const action of ["read", "list", "glob", "grep"]) rules.push({ action, resource: "*", effect: "allow" });
    if (!readonly && options.input.access === "auto-edit") rules.push({ action: "edit", resource: "*", effect: "allow" });
  }
  // Native child permission inheritance is not yet attested; managed children use the host bridge.
  rules.push({ action: "task", resource: "*", effect: "deny" });
  rules.push({ action: "subagent", resource: "*", effect: "deny" });
  rules.push({ action: "question", resource: "*", effect: "allow" });
  if (options.input.readOnlyProfile === "watcher") {
    for (const resource of [".env", "*.env", "*.env.*"]) rules.push({ action: "read", resource, effect: "deny" });
  }
  rules.push({ action: "inertia_*", resource: "*", effect: "deny" });
  if (hostName) rules.push({ action: `${hostName}_*`, resource: "*", effect: "allow" });
  return rules;
}

export async function openCode2Images(paths: readonly string[], roots: readonly string[] | undefined, signal?: AbortSignal) {
  if (paths.length > MAX_PROVIDER_REQUEST_IMAGE_COUNT) throw new Error("Too many OpenCode images.");
  let bytes = 0; const files: { uri: string }[] = [];
  for (const path of paths) {
    const type = imageMediaType(path);
    if (!type || !isOwnAttachmentPath(path, roots)) throw new Error("OpenCode image is outside its authorized roots.");
    const data = await readBoundedProviderImage("OpenCode", path, bytes, signal); bytes += data.length;
    files.push({ uri: `data:${type};base64,${data.toString("base64")}` });
  }
  return files;
}

function count(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
export function openCode2Usage(raw: unknown, contextWindow?: number, session = false): ProviderUsageEvent["usage"] {
  const tokens = objectValue(raw); const cache = objectValue(tokens?.cache);
  const input = count(tokens?.input); const output = count(tokens?.output); const reasoning = count(tokens?.reasoning);
  const read = count(cache?.read); const write = count(cache?.write);
  const known = [input, output, reasoning, read, write].every((value) => value !== null);
  return { usedTokens: !session && input !== null && read !== null && write !== null ? input + read + write : null,
    maxTokens: count(contextWindow), totalProcessedTokens: known ? input! + output! + reasoning! + read! + write! : null,
    totalProcessedScope: session ? "session" : "run", inputTokens: input, outputTokens: output, cachedInputTokens: read,
    cacheWriteInputTokens: write, reasoningOutputTokens: reasoning, compactsAutomatically: null };
}
