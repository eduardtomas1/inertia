import { z } from "zod";

import { modelSelectionForBackendModel, type ModelBackendProfileDetail } from "../../shared/backend-profile-settings";
import type {
  Conversation,
  ModelBackendProfileView,
  ProviderId,
  ProviderInfo,
} from "../../shared/contracts";
import { providerIdForHarness, type ModelSelection } from "../../shared/model-routing";
import { MAX_PROVIDER_HOST_TOOL_RESULT_BYTES } from "../../shared/provider-host-tools";
import { RecordNotFoundError } from "../persistence/errors";
import type {
  ProviderHostToolDefinition,
  ProviderHostToolResult,
} from "../provider/contracts";
import { routeSchema } from "./agent-thread-schemas";
import type { BackendProfileController } from "./backends/backend-profile-controller";
import { boundedUntrustedAgentText } from "./untrusted-agent-text";

export const MODEL_LIST_TOOL_NAME = "inertia_list_models";

/** Without a backend filter each backend shows at most this many models. */
export const MAX_LISTED_MODELS_PER_BACKEND = 40;
/**
 * Each route check re-reads the backend's stored profile, so a large custom
 * backend takes thousands of checks; yield between batches to keep the
 * runtime responsive and to notice cancellation.
 */
const ROUTE_CHECKS_PER_YIELD = 64;
const MAX_RESULT_BYTES = MAX_PROVIDER_HOST_TOOL_RESULT_BYTES - 1_024;
const MAX_LABEL_BYTES = 160;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f\u2028\u2029]/gu;
const PROBED_ON_USE = new Set(["probe-required", "probe-stale"]);
const INCOMPATIBLE = new Set(["protocol-mismatch", "cursor-managed", "opencode-native-catalog"]);
const KEY_READY = new Set(["configured", "not-required"]);

const modelListSchema = z.object({
  backendProfileId: z.string()
    .min(1)
    .max(200)
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "must be one line without control characters")
    .optional(),
}).strict();

export const MODEL_LIST_TOOL_DEFINITION: ProviderHostToolDefinition = {
  name: MODEL_LIST_TOOL_NAME,
  description: "List backends and models for the route of inertia_create_conversation: backendProfileId, modelId, reasoning efforts, providerId. Marks this chat's route and what can't run now, with why.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      backendProfileId: { type: "string", minLength: 1, maxLength: 200, description: "Only this backend, with all its models." },
    },
  },
  inputValidator: modelListSchema,
  readOnly: true,
};

/** One `route` argument of `inertia_create_conversation`, every field explicit. */
export interface ModelRouteCandidate {
  providerId: ProviderId;
  backendProfileId: string;
  modelId: string;
  reasoningEffort: string | null;
}

/** The `route` argument of `inertia_create_conversation` after its schema accepted it. */
export interface RouteInput {
  providerId?: ProviderId;
  backendProfileId?: string;
  modelId?: string;
  reasoningEffort?: string | null;
}

const LIST_HINT = `call ${MODEL_LIST_TOOL_NAME} for valid routes`;

/**
 * A selection for one model of a backend as the profile controller shows it.
 * The controller's view carries status fields that the stored profile schema
 * rejects, so the selection is built from the view's model directly; the
 * controller's validation then makes it canonical.
 */
function routeSelection(profile: ModelBackendProfileDetail, modelId: string, reasoningEffort: string | null): ModelSelection {
  const model = profile.models.find(({ id }) => id === modelId);
  if (!model) throw new Error(`route.modelId: not a model of this backend; ${LIST_HINT}.`);
  return modelSelectionForBackendModel(profile, model, reasoningEffort);
}

/**
 * The verified selection `inertia_create_conversation` uses for `input`.
 * Fields left out keep the source chat's route when it names the same
 * backend, and otherwise the backend's primary model with no reasoning effort.
 */
export function resolveRouteSelection(
  controller: Pick<BackendProfileController, "detail" | "validateSelection">,
  source: Pick<Conversation, "modelSelection">,
  input: RouteInput | undefined,
  detail: (profileId: string) => ModelBackendProfileDetail = (profileId) => controller.detail(profileId),
): ModelSelection {
  const current = source.modelSelection;
  if (!input) return controller.validateSelection(current);
  const profileId = input.backendProfileId ?? current.backendProfileId;
  let profile: ModelBackendProfileDetail;
  try {
    profile = detail(profileId);
  } catch (error) {
    if (error instanceof RecordNotFoundError) throw new Error(`route.backendProfileId: no such backend; ${LIST_HINT}.`);
    throw error;
  }
  const sameBackend = profileId === current.backendProfileId;
  const modelId = input.modelId ?? (sameBackend ? current.modelId : profile.routing.primaryModelId);
  const reasoningEffort = input.reasoningEffort !== undefined
    ? input.reasoningEffort
    : sameBackend && modelId === current.modelId ? current.reasoningEffort : null;
  const selection = controller.validateSelection(routeSelection(profile, modelId, reasoningEffort));
  const providerId = providerIdForHarness(selection.harnessId);
  if (!providerId || (input.providerId && input.providerId !== providerId)) {
    throw new Error(`route.providerId: does not match the backend's provider; ${LIST_HINT}.`);
  }
  return selection;
}

export interface ModelListDependencies {
  profiles(): readonly ModelBackendProfileView[];
  providerInfo(): readonly ProviderInfo[];
  /** Whether `inertia_create_conversation` accepts this exact route. */
  accepts(route: ModelRouteCandidate): boolean;
}

interface ListedModel {
  modelId: string;
  label?: string;
  reasoningEfforts?: string[];
  usable?: false;
  reason?: string;
  current?: true;
}

interface ListedBackend {
  backendProfileId: string;
  name: string;
  providerId: ProviderId;
  routeKind: ModelBackendProfileView["routeKind"];
  usable: boolean;
  reason?: string;
  primaryModelId: string;
  models: ListedModel[];
  modelsTruncated?: true;
  totalModels?: number;
}

function label(value: string): string {
  return boundedUntrustedAgentText(value.replace(CONTROL_CHARACTERS, " ").trim(), MAX_LABEL_BYTES).text;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function harnessProblem(provider: ProviderInfo | undefined): string | null {
  if (!provider || provider.installState !== "installed" || !provider.available || !provider.executable) {
    return "Its agent CLI is not installed or could not start.";
  }
  return provider.updateRequired ? "Its agent CLI needs an update." : null;
}

/**
 * Why the route-readiness check of `inertia_create_conversation` would refuse
 * this backend, from state Inertia already holds. It never probes a backend,
 * so a route that needs a connection test reads as usable: Inertia tests it
 * when the chat starts.
 */
function backendProblem(view: ModelBackendProfileView, provider: ProviderInfo | undefined): string | null {
  if (view.preset === "native") {
    if (provider?.canRun === true) return null;
    const harness = harnessProblem(provider);
    if (harness) return harness;
    return provider?.authState === "unauthenticated" || provider?.authState === "unknown"
      ? "The user has not signed in to it."
      : "It cannot run right now.";
  }
  if (view.compatibility.reasonCode === "credential-required") return "It needs an API key in Settings.";
  if (!view.enabled) return "It is turned off in Settings.";
  const harness = harnessProblem(provider);
  if (harness) return harness;
  if (view.authState === "missing" || view.authState === "unavailable") return "Its API key is missing.";
  return null;
}

function probesOverHttp(view: ModelBackendProfileView): boolean {
  return view.source === "custom"
    && view.endpointHost !== null
    && (view.protocol === "anthropic-messages" || view.protocol === "openai-responses");
}

function modelProblem(
  view: ModelBackendProfileView,
  model: ModelBackendProfileView["models"][number],
): string | null {
  if (view.preset === "native" || view.preset === "kimi-code") return null;
  const { compatibility } = model;
  if (compatibility.state !== "unknown" && compatibility.state !== "unavailable") return null;
  if (compatibility.reasonCode === "credential-required") return "It needs an API key in Settings.";
  if (INCOMPATIBLE.has(compatibility.reasonCode)) return "It is not compatible with its agent harness.";
  if (probesOverHttp(view) && (
    view.connectionState === "testing"
    || view.renewing === true
    || (PROBED_ON_USE.has(compatibility.reasonCode) && KEY_READY.has(view.authState))
  )) return null;
  return "Its last connection test failed; the user can test it again in Settings.";
}

function invalidBackend(): ProviderHostToolResult {
  return {
    success: false,
    text: JSON.stringify({
      error: {
        code: "invalid_arguments",
        message: `backendProfileId: no such backend; omit it to list every backend\nFix it and call ${MODEL_LIST_TOOL_NAME} again.`,
      },
    }),
  };
}

function cancelled(): ProviderHostToolResult {
  return { success: false, text: JSON.stringify({ error: { code: "call_cancelled", message: "The host tool call was cancelled." } }) };
}

/**
 * The backends and models `inertia_create_conversation` can route to. Every
 * listed backend, model and reasoning effort has passed that tool's own route
 * validation, so an agent can pass them back unchanged.
 */
export async function listModelRoutes(
  current: Conversation,
  args: unknown,
  dependencies: ModelListDependencies,
  signal: AbortSignal,
): Promise<ProviderHostToolResult> {
  const input = modelListSchema.parse(args ?? {});
  let checks = 0;
  const accepts = async (route: ModelRouteCandidate): Promise<boolean> => {
    checks += 1;
    if (checks % ROUTE_CHECKS_PER_YIELD === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    return !signal.aborted && dependencies.accepts(route);
  };
  const providers = dependencies.providerInfo();
  const views = dependencies.profiles()
    .filter(({ id }) => input.backendProfileId === undefined || id === input.backendProfileId);
  if (input.backendProfileId !== undefined && views.length === 0) return invalidBackend();
  const selection = current.modelSelection;
  const modelLimit = input.backendProfileId === undefined ? MAX_LISTED_MODELS_PER_BACKEND : Number.POSITIVE_INFINITY;
  const backends: ListedBackend[] = [];
  for (const view of views) {
    const providerId = providerIdForHarness(view.harnessId);
    if (!providerId) continue;
    const route = (modelId: string, reasoningEffort: string | null): ModelRouteCandidate => ({
      providerId, backendProfileId: view.id, modelId, reasoningEffort,
    });
    const problem = backendProblem(view, providers.find(({ id }) => id === providerId));
    const models: ListedModel[] = [];
    let accepted = 0;
    for (const model of view.models) {
      if (!await accepts(route(model.id, null))) continue;
      accepted += 1;
      if (models.length >= modelLimit) continue;
      const efforts: string[] = [];
      for (const { value } of model.reasoningOptions) {
        if (await accepts(route(model.id, value))) efforts.push(value);
      }
      const modelReason = problem === null ? modelProblem(view, model) : null;
      const shown = model.displayName === model.id ? null : label(model.displayName);
      models.push({
        modelId: model.id,
        ...(shown ? { label: shown } : {}),
        ...(efforts.length > 0 ? { reasoningEfforts: efforts } : {}),
        ...(modelReason ? { usable: false as const, reason: modelReason } : {}),
        ...(view.id === selection.backendProfileId && model.id === selection.modelId ? { current: true as const } : {}),
      });
    }
    if (models.length === 0) continue;
    backends.push({
      backendProfileId: view.id,
      name: label(view.displayName),
      providerId,
      routeKind: view.routeKind,
      usable: problem === null,
      ...(problem ? { reason: problem } : {}),
      primaryModelId: view.routing.primaryModelId,
      models,
      ...(accepted > models.length ? { modelsTruncated: true as const, totalModels: accepted } : {}),
    });
  }
  if (signal.aborted) return cancelled();
  // Usable backends first, so a cut drops only backends that cannot run now.
  backends.sort((left, right) => Number(right.usable) - Number(left.usable));
  const result = (included: ListedBackend[], truncated: boolean) => ({
    current: {
      backendProfileId: selection.backendProfileId,
      modelId: selection.modelId,
      reasoningEffort: selection.reasoningEffort,
    },
    backends: included,
    truncated,
    next: truncated || included.some(({ modelsTruncated }) => modelsTruncated)
      ? input.backendProfileId === undefined
        ? `Some backends or models are cut; call ${MODEL_LIST_TOOL_NAME} with a backendProfileId to see one backend in full.`
        : "This backend's models were cut at the result size limit."
      : "Pass backendProfileId and modelId, and optionally reasoningEffort and providerId, as route to inertia_create_conversation; modelId defaults to primaryModelId. Choose a usable backend and model.",
  });
  const included: ListedBackend[] = [];
  for (const backend of backends) {
    if (jsonBytes(result([...included, backend], true)) > MAX_RESULT_BYTES) break;
    included.push(backend);
  }
  // One backend's models alone can exceed the limit: keep as many as fit.
  if (included.length === 0 && backends[0]) {
    const backend = backends[0];
    const total = backend.totalModels ?? backend.models.length;
    const kept: ListedModel[] = [];
    for (const model of backend.models) {
      const candidate = { ...backend, models: [...kept, model], modelsTruncated: true as const, totalModels: total };
      if (jsonBytes(result([candidate], true)) > MAX_RESULT_BYTES) break;
      kept.push(model);
    }
    if (kept.length > 0) included.push({ ...backend, models: kept, modelsTruncated: true, totalModels: total });
  }
  return { success: true, text: JSON.stringify(result(included, included.length < backends.length)) };
}

/** Whether `inertia_create_conversation` would accept `route` exactly as given. */
function routeAccepted(
  controller: Pick<BackendProfileController, "detail" | "validateSelection">,
  source: Conversation,
  route: ModelRouteCandidate,
  detail: (profileId: string) => ModelBackendProfileDetail,
): boolean {
  const parsed = routeSchema.safeParse(route);
  const fields = Object.keys(route) as (keyof ModelRouteCandidate)[];
  if (!parsed.success || fields.some((field) => parsed.data[field] !== route[field])) return false;
  try {
    resolveRouteSelection(controller, source, parsed.data, detail);
    return true;
  } catch {
    return false;
  }
}

/** `inertia_list_models`: the routes the create call accepts as listed, for the chat `source`. */
export async function listAcceptedModelRoutes(
  controller: Pick<BackendProfileController, "detail" | "profiles" | "validateSelection">,
  providerInfo: readonly ProviderInfo[],
  source: Conversation,
  args: unknown,
  signal: AbortSignal,
): Promise<ProviderHostToolResult> {
  // One read per backend instead of one per model and reasoning effort.
  const details = new Map<string, ModelBackendProfileDetail>();
  const detail = (profileId: string): ModelBackendProfileDetail => {
    const known = details.get(profileId) ?? controller.detail(profileId);
    details.set(profileId, known);
    return known;
  };
  return listModelRoutes(source, args, {
    profiles: () => controller.profiles(providerInfo),
    providerInfo: () => providerInfo,
    accepts: (route) => routeAccepted(controller, source, route, detail),
  }, signal);
}
