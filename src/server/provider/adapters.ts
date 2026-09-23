import { isAbsolute } from "node:path";

import { PROVIDER_INFO } from "./catalog";
import {
  versionedContinuationIdentitySchema,
  currentKnownHarnessIdSchema,
  modelBackendProfileSchema,
  modelSelectionSchema,
  providerNativeBackendProfile,
  type ModelBackendProfile,
} from "../../shared/model-routing";
import { MAX_CLAUDE_TURN_BUDGET_USD } from "../../shared/project-preferences";
import {
  PROVIDER_IDS,
  ProviderRuntimeError,
  type ProviderId,
  type ProviderRunInput,
} from "./contracts";

const MAX_PROMPT_CHARS = 256 * 1024;
const MAX_IMAGE_COUNT = 32;
const MAX_SKILL_COUNT = 8;

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

export function validateProviderRunInput(input: ProviderRunInput): string {
  if (!isProviderId(input.providerId)) throw new ProviderRuntimeError("invalid_input", "Unknown provider.");
  if (!currentKnownHarnessIdSchema.safeParse(input.harnessId).success) {
    throw new ProviderRuntimeError("invalid_input", "Unknown agent harness.");
  }
  if (!modelBackendProfileSchema.safeParse(input.backendProfile).success) {
    throw new ProviderRuntimeError("invalid_input", "The model backend profile is invalid.");
  }
  if (!modelSelectionSchema.safeParse(input.modelSelection).success) {
    throw new ProviderRuntimeError("invalid_input", "The model selection is invalid.");
  }
  if (!versionedContinuationIdentitySchema.safeParse(input.continuationIdentity).success) {
    throw new ProviderRuntimeError("invalid_input", "The continuation identity is invalid.");
  }
  const providerOptionKeys = Object.keys(input.modelSelection.providerOptions);
  const fastMode = input.modelSelection.providerOptions.fastMode;
  const expectedFastMode = input.providerId === "codex"
    ? "priority"
    : input.providerId === "claude"
      ? "fast"
      : null;
  const nativeFastModeRoute = expectedFastMode !== null
    && input.backendProfile.id === providerNativeBackendProfile(input.providerId).id
    && input.harnessId === (input.providerId === "codex"
      ? "codex-app-server"
      : "claude-agent-sdk");
  if (
    providerOptionKeys.length > 1
    || (providerOptionKeys.length === 1 && providerOptionKeys[0] !== "fastMode")
    || (providerOptionKeys.length === 1 && typeof fastMode !== "string")
    || (
      fastMode !== undefined
      && (
        fastMode !== expectedFastMode
        || !nativeFastModeRoute
      )
    )
    || (
      input.supportedFastMode !== undefined
      && (
        input.supportedFastMode !== expectedFastMode
        || !nativeFastModeRoute
      )
    )
    || (fastMode !== undefined && input.supportedFastMode !== expectedFastMode)
    || (input.continuationIdentity.performanceModeIdentity ?? null)
      !== (fastMode === undefined ? null : `fast:${fastMode}`)
  ) {
    throw new ProviderRuntimeError(
      "invalid_input",
      "The provider-native Fast mode route is invalid.",
    );
  }
  if (
    input.performanceModeTransition !== undefined
    && (
      !input.sessionId
      || !nativeFastModeRoute
      || input.supportedFastMode !== expectedFastMode
      || (input.performanceModeTransition === "to-fast"
        ? fastMode === undefined
        : input.performanceModeTransition === "to-standard"
          ? fastMode !== undefined
          : true)
    )
  ) {
    throw new ProviderRuntimeError(
      "invalid_input",
      "The response speed continuation transition is invalid.",
    );
  }
  const conversationId = input.conversationId?.trim();
  if (!conversationId || conversationId.length > 512 || conversationId.includes("\0")) {
    throw new ProviderRuntimeError("invalid_input", "A valid conversation identifier is required.");
  }
  if (!input.cwd.trim() || input.cwd.includes("\0")) {
    throw new ProviderRuntimeError("invalid_input", "A valid project directory is required.");
  }
  if (!input.prompt.trim()) throw new ProviderRuntimeError("invalid_input", "A prompt is required.");
  if (input.prompt.length > MAX_PROMPT_CHARS || input.prompt.includes("\0")) {
    throw new ProviderRuntimeError("invalid_input", "The prompt is too large.");
  }
  if (
    input.goalContinuationExpected !== undefined
    && typeof input.goalContinuationExpected !== "boolean"
  ) {
    throw new ProviderRuntimeError(
      "invalid_input",
      "The goal continuation hint is invalid.",
    );
  }
  if (
    input.goalContinuationExpected === true
    && (
      input.providerId !== "codex"
      || input.harnessId !== "codex-app-server"
      || (!input.sessionId && !input.goalStart)
    )
  ) {
    throw new ProviderRuntimeError(
      "invalid_input",
      "The goal continuation hint is invalid.",
    );
  }
  if (
    input.maxBudgetUsd !== undefined
    && (
      typeof input.maxBudgetUsd !== "number"
      || !Number.isFinite(input.maxBudgetUsd)
      || input.maxBudgetUsd <= 0
      || input.maxBudgetUsd > MAX_CLAUDE_TURN_BUDGET_USD
    )
  ) {
    throw new ProviderRuntimeError(
      "invalid_input",
      "The spend limit is invalid.",
    );
  }
  if (input.goalStart) {
    const objective = input.goalStart.objective?.trim();
    const budget = input.goalStart.tokenBudget;
    if (
      input.providerId !== "codex"
      || input.harnessId !== "codex-app-server"
      || (input.goalStart.objective !== undefined && (
        !objective
        || objective.length > 4_000
        || objective.includes("\0")
      ))
      || (
        budget !== undefined
        && budget !== null
        && (
          !Number.isSafeInteger(budget)
          || budget < 1
          || budget > 1_000_000_000
        )
      )
    ) {
      throw new ProviderRuntimeError(
        "invalid_input",
        "The native goal start request is invalid.",
      );
    }
  }
  if (input.operation) {
    const instruction = input.operation.instruction?.trim();
    if (
      input.operation.kind !== "compact"
      || !input.sessionId
      || input.performanceModeTransition !== undefined
      || input.goalStart !== undefined
      || input.goalContinuationExpected !== undefined
      || (input.imagePaths?.length ?? 0) > 0
      || (input.skills?.length ?? 0) > 0
      || (input.operation.instruction !== undefined && (
        !instruction
        || instruction.length > 4_000
        || instruction.includes("\0")
      ))
    ) {
      throw new ProviderRuntimeError(
        "invalid_input",
        "The provider compaction request is invalid.",
      );
    }
  }
  for (const value of [input.runId, input.turnId]) {
    if (typeof value !== "string" || !value.trim() || value.length > 512 || value.includes("\0")) {
      throw new ProviderRuntimeError("invalid_input", "Exact run and turn identities are required.");
    }
  }
  for (const value of [input.model, input.sessionId]) {
    if (value !== undefined && (!value.trim() || value.length > 512 || value.includes("\0"))) {
      throw new ProviderRuntimeError("invalid_input", "A provider option is invalid.");
    }
  }
  const imagePaths = input.imagePaths ?? [];
  if (imagePaths.length > MAX_IMAGE_COUNT) {
    throw new ProviderRuntimeError("invalid_input", "Too many images were attached.");
  }
  if (imagePaths.some((path) => !path.trim() || path.length > 4096 || path.includes("\0"))) {
    throw new ProviderRuntimeError("invalid_input", "An image path is invalid.");
  }
  const skills = input.skills ?? [];
  if (skills.length > MAX_SKILL_COUNT) {
    throw new ProviderRuntimeError("invalid_input", "Too many skills were selected.");
  }
  if (
    skills.length > 0
    && input.harnessId !== "codex-app-server"
    && input.harnessId !== "claude-agent-sdk"
  ) {
    throw new ProviderRuntimeError(
      "invalid_input",
      "The selected harness does not support structured skills.",
    );
  }
  if (skills.some((skill) =>
    !skill.name.trim()
    || skill.name.length > 160
    || skill.name.includes("\0")
    || (
      input.harnessId === "codex-app-server"
      && (
        skill.source !== "codex-native"
        || !skill.path.trim()
        || !isAbsolute(skill.path)
        || skill.path.length > 4096
        || skill.path.includes("\0")
      )
    )
    || (
      input.harnessId === "claude-agent-sdk"
      && skill.source !== "claude-native"
    )
  )) {
    throw new ProviderRuntimeError("invalid_input", "A skill reference is invalid.");
  }
  return conversationId;
}

export function providerFailureMessage(
  providerId: ProviderId,
  spawnError: NodeJS.ErrnoException | undefined,
  stderr: string,
  providerOutput = "",
  backendProfile?: Pick<
    ModelBackendProfile,
    "id" | "displayName" | "authenticationMode"
  >,
): string {
  const providerName = PROVIDER_INFO[providerId].name;
  const customBackend = backendProfile !== undefined
    && backendProfile.id !== providerNativeBackendProfile(providerId).id;
  const backendName = customBackend
    ? safeProviderBackendLabel(backendProfile.displayName)
    : providerName;
  if (spawnError?.code === "ENOENT") return `${providerName} CLI is not installed or is not available on PATH.`;
  if (spawnError?.code === "EACCES") return `${providerName} CLI could not be started because it is not executable.`;
  const normalized = `${stderr}\n${providerOutput}`.toLowerCase();
  if (/requires a newer version|please upgrade (?:to )?the latest (?:app|cli)|cli.+out of date/.test(normalized)) {
    return `${providerName} needs an update before it can run the selected model.`;
  }
  if (/not (?:logged|signed) in|authentication required|failed to authenticate|oauth session expired|unauthorized|credential (?:is )?unavailable|invalid (?:api[ -]?key|token|credential)|please (?:log|sign) in|\b401\b/.test(normalized)) {
    return customBackend
      ? `Authentication failed for ${backendName}. Check this model backend's credential and try again.`
      : `${providerName} is not authenticated. Sign in with its CLI and try again.`;
  }
  if (/rate.?limit|too many requests|quota|\b429\b/.test(normalized)) {
    return `${backendName} is temporarily rate limited. Try again shortly.`;
  }
  if (/model.+(?:not found|unknown|invalid|unavailable)/.test(normalized)) {
    return `The selected ${backendName} model is unavailable.`;
  }
  return `${backendName} could not complete the request.`;
}

/** Safe persisted backend labels may still contain control characters. */
export function safeProviderBackendLabel(value: string): string {
  const label = value
    .replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
  return label || "the selected model backend";
}
