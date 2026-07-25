import { createHash } from "node:crypto";

import { isBackendCredentialProfileId } from "../shared/backend-credentials.js";

/**
 * Node-only derivation shared by the trusted Electron main process and the
 * utility runtime. The opaque reference is safe to correlate but is never
 * credential material and must not be sent to the renderer.
 */
export function backendSecretReferenceForProfile(profileId: string): string {
  if (!isBackendCredentialProfileId(profileId)) {
    throw new Error("The backend profile identifier is invalid.");
  }
  return `secret:backend:${createHash("sha256").update(profileId).digest("hex")}`;
}
