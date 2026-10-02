import { USAGE_ACCOUNT_IDENTITY_SECRET_REFERENCE } from "../node/backend-secret-reference.js";
import type { CredentialVault } from "./credential-vault.js";
import type { RuntimeCredentialBroker } from "./runtime-supervisor-types.js";

export function runtimeCredentialBroker(vault: () => CredentialVault): RuntimeCredentialBroker {
  return {
    resolve: (secretReference) => secretReference === USAGE_ACCOUNT_IDENTITY_SECRET_REFERENCE
      ? vault().resolveOrCreate(secretReference)
      : vault().resolve(secretReference),
    status: (secretReference) => vault().status(secretReference),
    clear: (secretReference) => vault().clear(secretReference),
    forget: (secretReference) => vault().forget(secretReference),
  };
}
