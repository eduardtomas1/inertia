import { createHash } from "node:crypto";

import type { ProviderActivityPhase } from "./contracts";

/** Anonymous starts cannot be correlated safely, so persist them as facts. */
export function contractActivityPhase(
  phase: ProviderActivityPhase,
  activityId: string | undefined,
): ProviderActivityPhase {
  return phase === "started" && !activityId ? "info" : phase;
}

/**
 * Creates a bounded, opaque identity for a provider lifecycle whose protocol
 * does not expose a native ID. Every component must be invariant from start
 * through the terminal notification.
 */
export function stableProviderActivityId(
  namespace: string,
  ...components: Array<string | number | null | undefined>
): string {
  const digest = createHash("sha256");
  digest.update(namespace);
  for (const component of components) {
    const value = component === null || component === undefined
      ? ""
      : String(component);
    digest.update(`\0${Buffer.byteLength(value, "utf8")}:`);
    digest.update(value);
  }
  return `inertia:${namespace}:${digest.digest("hex").slice(0, 32)}`;
}
