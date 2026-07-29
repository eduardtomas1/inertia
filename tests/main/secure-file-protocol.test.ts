import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseSecureFileRequest,
  parseSecureFileResult,
} from "../../src/node/secure-file-protocol";

const identity = { dev: "1", ino: "2" };

describe("secure file protocol", () => {
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
});
