// @inertia-test-suite portable
import { describe, expect, it } from "vitest";

import { AcpSecretRedactor } from "../../src/server/provider/acp-redaction";
import { CappedProviderBuffer } from "../../src/server/provider/io";

describe("ACP diagnostic stream redaction", () => {
  it("redacts a credential split where a raw cap would retain its prefix", () => {
    const secret = "split-secret-value";
    const split = 9;
    const redactor = new AcpSecretRedactor({ KIMI_API_KEY: secret });
    const capped = new CappedProviderBuffer(12);

    capped.append(redactor.stderrChunk(`safe:${secret.slice(0, split)}`));
    capped.append(redactor.stderrChunk(secret.slice(split)));
    capped.append(redactor.finishStderr());

    expect(capped.toString()).toContain("safe:");
    expect(capped.toString()).toContain("[redac");
    expect(capped.toString()).not.toContain(secret.slice(0, split));
    expect(capped.toString()).not.toContain(secret);
  });

  it("does not flush a terminal credential prefix into diagnostics", () => {
    const secret = "terminal-secret-value";
    const prefix = secret.slice(0, 11);
    const redactor = new AcpSecretRedactor({ KIMI_API_KEY: secret });

    const output = redactor.stderrChunk(`diagnostic:${prefix}`)
      + redactor.finishStderr();

    expect(output).toBe("diagnostic:[redacted]");
    expect(output).not.toContain(prefix);
  });

  it("keeps paths and ordinary configuration out of the secret inventory", () => {
    const redactor = new AcpSecretRedactor({
      KIMI_API_KEY: "kimi-credential",
      KIMI_CONFIG_FILE: "/Users/example/.kimi/config.toml",
      PWD: "/Users/example/project",
    });

    expect(redactor.payload({
      text: "kimi-credential /Users/example/.kimi/config.toml /Users/example/project",
    })).toEqual({
      text: "[redacted] /Users/example/.kimi/config.toml /Users/example/project",
    });
  });
});
