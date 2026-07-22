import { describe, expect, it } from "vitest";

import { providerSetupAction, providerStateLabel } from "../../src/renderer/src/utils/providerStatus";
import type { ProviderInfo } from "../../src/shared/contracts";

describe("provider compatibility status", () => {
  it("offers refresh instead of sign-in when an authenticated Codex CLI needs an update", () => {
    const provider: ProviderInfo = {
      id: "codex",
      label: "Codex",
      command: "codex",
      available: true,
      version: "0.1.0",
      installState: "installed",
      authState: "authenticated",
      canRun: false,
      statusMessage: "Update Codex CLI to enable agent conversations",
    };

    expect(providerStateLabel(provider)).toBe("Update required");
    expect(providerSetupAction(provider)).toBe("refresh");
  });
});
