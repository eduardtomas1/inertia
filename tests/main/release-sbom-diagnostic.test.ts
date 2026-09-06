import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const { releaseSbomFailureMessage } = await import(pathToFileURL(
  resolve(import.meta.dirname, "../../scripts/release-sbom-diagnostic.mjs"),
).href);

function diagnostic(result: unknown, elapsedMs = 60_012.75) {
  const message = releaseSbomFailureMessage(result, elapsedMs) as string;
  expect(message).toMatch(/^The release dependency SBOM could not be generated\. /u);
  expect(message.length).toBeLessThan(300);
  return JSON.parse(message.slice(message.indexOf("{"))) as Record<string, unknown>;
}

describe("release SBOM failure evidence", () => {
  it("distinguishes an actual child timeout from a merely long command", () => {
    expect(diagnostic({
      error: Object.assign(new Error("private timeout context"), { code: "ETIMEDOUT" }),
      status: null, signal: "SIGTERM", stdout: "", stderr: "",
    })).toEqual({
      elapsedMs: 60_013, status: null, signal: "SIGTERM", errorCode: "ETIMEDOUT",
      stdoutBytes: 0, stderrBytes: 0,
    });
    expect(diagnostic({ status: 1, signal: null, stdout: "", stderr: "" }))
      .toMatchObject({ elapsedMs: 60_013, status: 1, errorCode: null });
  });

  it.each(["ENOBUFS", "ENOENT", "EACCES", "EAGAIN"])(
    "retains the allowlisted %s failure without the error message",
    (code) => {
      expect(diagnostic({
        error: { code, message: "secret spawn context" },
        status: null, signal: null, stdout: null, stderr: null,
      })).toMatchObject({ errorCode: code, stdoutBytes: null, stderrBytes: null });
    },
  );

  it("keeps nonzero exit status and counts UTF-8 bytes without retaining npm output", () => {
    expect(diagnostic({
      status: 1, signal: null, stdout: "🙂", stderr: Buffer.from("é"),
    }, 120.25)).toEqual({
      elapsedMs: 120, status: 1, signal: null, errorCode: null,
      stdoutBytes: 4, stderrBytes: 2,
    });
  });

  it("replaces unknown codes and signals and never serializes sentinel secrets", () => {
    const sentinel = "sbom-diagnostic-private-sentinel";
    const value = {
      status: sentinel, signal: `SIG${sentinel}`,
      error: { code: sentinel, message: sentinel, stack: sentinel },
      stdout: sentinel.repeat(1_000), stderr: Buffer.from(sentinel),
      config: sentinel, env: sentinel, argv: [sentinel],
    };
    const message = releaseSbomFailureMessage(value, 60_000) as string;
    expect(message).not.toContain(sentinel);
    expect(diagnostic(value)).toEqual({
      elapsedMs: 60_013, status: "UNKNOWN", signal: "UNKNOWN", errorCode: "UNKNOWN",
      stdoutBytes: Buffer.byteLength(value.stdout), stderrBytes: value.stderr.byteLength,
    });
  });

  it("never reads error message, stack, configuration, environment or argv", () => {
    const error = { code: "ETIMEDOUT" };
    const result = { error, status: null, signal: "SIGKILL", stdout: "", stderr: "" };
    for (const [target, fields] of [
      [error, ["message", "stack"]],
      [result, ["config", "env", "argv"]],
    ] as const) {
      for (const key of fields) Object.defineProperty(target, key, {
        get: () => { throw new Error("Private field must never be read"); },
      });
    }
    expect(diagnostic(result)).toMatchObject({ errorCode: "ETIMEDOUT", signal: "SIGKILL" });
  });

  it.each([NaN, Infinity, -1])("bounds invalid elapsed time %s without coercing unknown values", (elapsedMs) => {
    expect(diagnostic({
      status: Infinity, signal: { toString: () => "secret" }, error: {},
      stdout: { toString: () => "secret" }, stderr: undefined,
    }, elapsedMs)).toEqual({
      elapsedMs: "UNKNOWN", status: "UNKNOWN", signal: "UNKNOWN", errorCode: "UNKNOWN",
      stdoutBytes: null, stderrBytes: null,
    });
  });
});
