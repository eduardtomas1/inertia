import {
  parseRuntimeLifecycleDiagnosticSnapshot,
  safeLifecycleProviderVersion,
} from "../lifecycle-diagnostics";
import { currentKnownHarnessIdSchema } from "../model-routing";

type UnknownRecord = Record<string, unknown>;

const PROVIDER_HARNESS_IDS = {
  codex: "codex-app-server",
  claude: "claude-agent-sdk",
  cursor: "cursor-acp",
  kimi: "kimi-acp",
  opencode: "opencode-sdk",
  antigravity: "antigravity-cli",
} as const;

const CAPABILITY_CONTRACT_KEYS = [
  "schemaVersion",
  "harnessId",
  "manifestDigest",
  "installationVerified",
  "installedVersion",
  "currentlyAvailableCount",
  "declaredCapabilityCount",
  "hostToolBridgeAvailable",
] as const;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
    && Number(value) <= 1_000_000;
}

export function optionalProviderCapabilityContract(
  value: unknown,
  expectedProviderId: unknown,
): boolean {
  if (value === undefined) return true;
  if (
    !record(value)
    || typeof expectedProviderId !== "string"
    || !Object.hasOwn(PROVIDER_HARNESS_IDS, expectedProviderId)
  ) return false;
  const expectedHarnessId = PROVIDER_HARNESS_IDS[
    expectedProviderId as keyof typeof PROVIDER_HARNESS_IDS
  ];
  if (
    Object.keys(value).some((key) => key !== "capabilities"
      && !CAPABILITY_CONTRACT_KEYS.includes(key as typeof CAPABILITY_CONTRACT_KEYS[number]))
    || !CAPABILITY_CONTRACT_KEYS.every((key) => Object.hasOwn(value, key))
    || value.schemaVersion !== 1
    || !currentKnownHarnessIdSchema.safeParse(value.harnessId).success
    || value.harnessId !== expectedHarnessId
    || typeof value.manifestDigest !== "string"
    || !/^[0-9a-f]{64}$/u.test(value.manifestDigest)
    || typeof value.installationVerified !== "boolean"
    || typeof value.hostToolBridgeAvailable !== "boolean"
    || !boundedCount(value.currentlyAvailableCount)
    || !boundedCount(value.declaredCapabilityCount)
    || value.currentlyAvailableCount > value.declaredCapabilityCount
    || (
      value.installedVersion !== null
      && (
        typeof value.installedVersion !== "string"
        || safeLifecycleProviderVersion(value.installedVersion)
          !== value.installedVersion
      )
    )
  ) return false;
  if (value.capabilities !== undefined) {
    if (!Array.isArray(value.capabilities) || value.capabilities.length > 64
      || value.capabilities.length !== value.declaredCapabilityCount) return false;
    const ids = new Set<string>();
    let available = 0;
    for (const capability of value.capabilities) {
      if (!record(capability) || Object.keys(capability).length !== 2
        || typeof capability.id !== "string" || !/^[a-z][a-z-]{0,63}$/u.test(capability.id)
        || ids.has(capability.id)
        || !["available", "installation-unverified", "configuration-required", "negotiation-required", "unsupported"].includes(String(capability.state))) return false;
      ids.add(capability.id);
      if (capability.state === "available") available += 1;
    }
    if (available !== value.currentlyAvailableCount) return false;
  }
  return value.installationVerified
    ? value.installedVersion !== null
    : value.installedVersion === null
      && value.currentlyAvailableCount === 0
      && value.hostToolBridgeAvailable === false;
}

export function optionalRuntimeLifecycleDiagnostics(value: unknown): boolean {
  return value === undefined
    || parseRuntimeLifecycleDiagnosticSnapshot(value) !== null;
}
