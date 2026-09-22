// @inertia-test-suite portable
import { describe, expect, it } from "vitest";

import { openCodeRuntimeFailure } from "../../src/server/provider/opencode-sdk-support";

describe("OpenCode runtime failure", () => {
  it("keeps the server's stop output as technical detail without reclassifying the failure", () => {
    const failure = openCodeRuntimeFailure(
      "OpenCode closed its event stream before the session completed.",
      "OpenCode closed its event stream before the session completed.",
      "sdk/exception",
      undefined,
      undefined,
      "OpenCode server stopped: request timed out; worker crashed",
    );

    // The log mentions a timeout, but the observed failure is a closed stream.
    expect(failure.reason).toBe("transport-closed");
    expect(failure.message).toBe("OpenCode closed its event stream before the session completed.");
    expect(failure.technicalDetail).toContain("OpenCode server stopped: request timed out; worker crashed");
  });

  it("does not repeat the server output when it already is the error", () => {
    const stopped = "OpenCode server stopped: out of memory";
    const failure = openCodeRuntimeFailure(stopped, stopped, "sdk/exception", undefined, undefined, stopped);

    expect(failure.technicalDetail?.split(stopped).length ?? 1).toBeLessThanOrEqual(2);
  });
});
