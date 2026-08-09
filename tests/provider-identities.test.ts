import { describe, expect, it } from "vitest";

import { parseProviderIdentityLabels } from "../src/shared/provider-identities";

describe("provider identity labels", () => {
  it("normalizes bounded aliases and rejects unknown providers or line breaks", () => {
    expect(parseProviderIdentityLabels({
      codex: "  Work account  ",
      claude: "Personal",
    })).toEqual({ codex: "Work account", claude: "Personal" });
    expect(() => parseProviderIdentityLabels({ github: "token owner" }))
      .toThrow(/invalid provider/u);
    expect(() => parseProviderIdentityLabels({ codex: "one\ntwo" }))
      .toThrow(/safe characters/u);
  });
});
