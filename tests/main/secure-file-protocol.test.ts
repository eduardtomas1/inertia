import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseSecureFileRequest,
  parseSecureFileResult,
  secureFilePathSegments,
} from "../../src/node/secure-file-protocol";
import {
  parseSecureFileWorkerEvent,
  parseSecureFileWorkerRequest,
} from "../../src/main/secure-file-worker-protocol";

const identity = { dev: "1", ino: "2" };

describe("secure file protocol", () => {
  it("uses platform-specific separators without rejecting POSIX filename characters", () => {
    expect(secureFilePathSegments("notes\\draft.md", "linux"))
      .toEqual(["notes\\draft.md"]);
    expect(secureFilePathSegments("a:file.md", "darwin"))
      .toEqual(["a:file.md"]);
    expect(secureFilePathSegments("src\\example.ts", "win32"))
      .toEqual(["src", "example.ts"]);
    expect(secureFilePathSegments("src\\..\\outside.ts", "win32"))
      .toBeNull();
    expect(secureFilePathSegments("C:outside.ts", "win32")).toBeNull();
  });

  it("accepts bounded empty replacements and strict identity vectors", () => {
    const request = {
      operation: "replace",
      root: resolve("/tmp", "workspace"),
      rootIdentity: identity,
      parentIdentities: [identity],
      targetIdentity: identity,
      path: "src/empty.ts",
      maxBytes: 128,
      expectedDigest: "a".repeat(64),
      contentBase64: "",
      expectedMode: 0o644,
      mode: 0o644,
    };

    expect(parseSecureFileRequest(request)).toEqual(request);
    expect(parseSecureFileRequest({
      ...request,
      parentIdentities: [],
    })).toBeNull();
    expect(parseSecureFileRequest({
      ...request,
      path: "../outside.ts",
    })).toBeNull();
    expect(parseSecureFileRequest({
      ...request,
      contentBase64: Buffer.alloc(129).toString("base64"),
    })).toBeNull();
  });

  it("rejects malformed results and base64 length mismatches", () => {
    const metadata = {
      digest: "b".repeat(64),
      size: 1,
      modifiedAt: new Date(0).toISOString(),
      mode: 0o644,
    };
    expect(parseSecureFileResult({
      ok: true,
      operation: "read",
      contentBase64: Buffer.from("x").toString("base64"),
      metadata,
    })).not.toBeNull();
    expect(parseSecureFileResult({
      ok: true,
      operation: "read",
      contentBase64: "",
      metadata,
    })).toBeNull();
    expect(parseSecureFileResult({
      ok: false,
      code: "unavailable",
      message: "x".repeat(301),
    })).toBeNull();
    expect(parseSecureFileResult({
      ok: false,
      code: "unsafe",
      message: "The workspace identity changed.",
    })).toEqual({
      ok: false,
      code: "unsafe",
      message: "The workspace identity changed.",
    });
  });

  it("keeps the private worker transaction envelope strict", () => {
    const request = {
      operation: "read",
      root: resolve("/tmp", "workspace"),
      rootIdentity: identity,
      parentIdentities: [identity],
      targetIdentity: identity,
      path: "src/example.ts",
      maxBytes: 128,
    } as const;
    expect(parseSecureFileWorkerRequest({
      type: "secure-file.perform",
      request,
    })).toEqual({ type: "secure-file.perform", request });
    expect(parseSecureFileWorkerRequest({
      type: "secure-file.recover",
      request,
      extra: true,
    })).toBeNull();
    expect(parseSecureFileWorkerEvent({
      type: "secure-file.commit",
      phase: "started",
    })).toEqual({ type: "secure-file.commit", phase: "started" });
    expect(parseSecureFileWorkerEvent({
      type: "secure-file.recovery-result",
      ok: true,
    })).toEqual({ type: "secure-file.recovery-result", ok: true });
    expect(parseSecureFileWorkerEvent({
      type: "secure-file.commit",
      phase: "started",
      extra: true,
    })).toBeNull();
  });

  it("accepts only bounded recovery requests and results", () => {
    const recovery = {
      operation: "recover",
      root: resolve("/tmp", "workspace"),
      rootIdentity: identity,
      parentIdentities: [identity],
      path: "src/example.ts",
    } as const;
    expect(parseSecureFileRequest(recovery)).toEqual(recovery);
    expect(parseSecureFileRequest({
      ...recovery,
      targetIdentity: identity,
    })).toBeNull();
    expect(parseSecureFileResult({
      ok: true,
      operation: "recover",
    })).toEqual({ ok: true, operation: "recover" });
    expect(parseSecureFileResult({
      ok: true,
      operation: "recover",
      metadata: {},
    })).toBeNull();
  });
});
