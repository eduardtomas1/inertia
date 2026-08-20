import { describe, expect, it } from "vitest";

import {
  DetachedRuntimeCapabilityRegistry,
  DETACHED_RUNTIME_WEBSOCKET_PATH,
  MAX_DETACHED_RUNTIME_CAPABILITY_TTL_MS,
  mintDetachedRuntimeWebSocketUrl,
} from "../../src/node/detached-runtime-capability";

const BASE_URL = "ws://127.0.0.1:48123/runtime/J7sYwPK2nBcU_MockRuntimeBearer";
const WEBSOCKET_PATH = new URL(BASE_URL).pathname;
const CONVERSATION_ID = "5b6a62a0-0aa1-4f67-92a7-30e02aa98d71";
const OTHER_CONVERSATION_ID = "7aa9c13e-bca5-4b31-bd8c-ea61cd8b23fe";
const RUNTIME_GENERATION = "3f7543de-0bd6-4d50-aa2a-c57c95f06fc1";
const INITIAL_NOW = 1_780_000_000_000;

function entropy(byte: number): (size: number) => Uint8Array {
  return (size) => new Uint8Array(size).fill(byte);
}

function mint(options: {
  now?: number;
  entropyByte?: number;
  ttlMs?: number;
  websocketUrl?: string;
} = {}): string {
  return mintDetachedRuntimeWebSocketUrl({
    websocketUrl: options.websocketUrl ?? BASE_URL,
    conversationId: CONVERSATION_ID,
    clientId: "detached-window:17",
  }, {
    now: () => options.now ?? INITIAL_NOW,
    randomBytes: entropy(options.entropyByte ?? 7),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  });
}

function requestUrl(capabilityUrl: string): string {
  const parsed = new URL(capabilityUrl);
  return `${parsed.pathname}${parsed.search}`;
}

function registry(options: {
  now?: () => number;
  secret?: string;
  maxCapabilityTtlMs?: number;
  maxConsumedNonces?: number;
} = {}): DetachedRuntimeCapabilityRegistry {
  return new DetachedRuntimeCapabilityRegistry({
    websocketPath: WEBSOCKET_PATH,
    secret: options.secret ?? BASE_URL,
    now: options.now ?? (() => INITIAL_NOW),
    ...(options.maxCapabilityTtlMs === undefined
      ? {}
      : { maxCapabilityTtlMs: options.maxCapabilityTtlMs }),
    ...(options.maxConsumedNonces === undefined
      ? {}
      : { maxConsumedNonces: options.maxConsumedNonces }),
  });
}

describe("detached runtime capability", () => {
  it("mints, verifies, consumes, and preserves runtime resume parameters", () => {
    const minted = new URL(mint());
    expect(minted.pathname).toBe(DETACHED_RUNTIME_WEBSOCKET_PATH);
    expect(minted.pathname).not.toBe(WEBSOCKET_PATH);
    expect(minted.pathname).not.toContain(
      WEBSOCKET_PATH.slice(WEBSOCKET_PATH.lastIndexOf("/") + 1),
    );
    const stripped = new URL(minted);
    stripped.search = "";
    expect(stripped.toString()).not.toBe(BASE_URL);
    expect(stripped.toString()).not.toContain(WEBSOCKET_PATH);
    minted.searchParams.append("runtimeGeneration", RUNTIME_GENERATION);
    minted.searchParams.append("afterSequence", "42");
    minted.searchParams.append("conversationId", CONVERSATION_ID);

    const verifier = registry();
    const accepted = verifier.verifyAndConsume(requestUrl(minted.toString()));

    expect(accepted).toMatchObject({
      kind: "accepted",
      authority: {
        role: "detached-chat",
        version: 1,
        conversationId: CONVERSATION_ID,
        clientId: "detached-window:17",
        expiresAt: INITIAL_NOW + 15_000,
      },
      runtimeRequestUrl:
        `${WEBSOCKET_PATH}?runtimeGeneration=${RUNTIME_GENERATION}`
        + `&afterSequence=42&conversationId=${CONVERSATION_ID}`,
    });
    expect(verifier.verifyAndConsume(requestUrl(minted.toString())))
      .toEqual({ kind: "rejected", reason: "replayed" });
  });

  it("rejects signed-field and signature tampering without consuming a nonce", () => {
    const verifier = registry();
    const original = new URL(mint());
    const cases: Array<(url: URL) => void> = [
      (url) => url.searchParams.set("dc_conversation", OTHER_CONVERSATION_ID),
      (url) => url.searchParams.set("dc_client", "detached-window:18"),
      (url) => url.searchParams.set("dc_expires", String(INITIAL_NOW + 14_999)),
      (url) => url.searchParams.set("dc_version", "2"),
      (url) => {
        const signature = url.searchParams.get("dc_signature")!;
        url.searchParams.set(
          "dc_signature",
          `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`,
        );
      },
    ];

    for (const tamper of cases) {
      const changed = new URL(original);
      tamper(changed);
      expect(verifier.verifyAndConsume(requestUrl(changed.toString())))
        .toEqual({ kind: "rejected", reason: "invalid" });
    }
    expect(verifier.verifyAndConsume(requestUrl(original.toString())).kind)
      .toBe("accepted");
  });

  it("strictly rejects malformed or smuggled capability requests", () => {
    const verifier = registry();
    const duplicate = new URL(mint());
    duplicate.searchParams.append(
      "dc_signature",
      duplicate.searchParams.get("dc_signature")!,
    );
    const unknown = new URL(mint({ entropyByte: 8 }));
    unknown.searchParams.set("unexpected", "value");
    const invalidClient = new URL(mint({ entropyByte: 9 }));
    invalidClient.searchParams.set("dc_client", "invalid client");

    for (const candidate of [duplicate, unknown, invalidClient]) {
      expect(verifier.verifyAndConsume(requestUrl(candidate.toString())))
        .toEqual({ kind: "rejected", reason: "invalid" });
    }
    const capabilityOnBasePath = new URL(mint({ entropyByte: 10 }));
    capabilityOnBasePath.pathname = WEBSOCKET_PATH;
    expect(verifier.verifyAndConsume(requestUrl(capabilityOnBasePath.toString())))
      .toEqual({ kind: "rejected", reason: "invalid" });
    expect(verifier.verifyAndConsume(WEBSOCKET_PATH)).toEqual({ kind: "absent" });
    expect(verifier.verifyAndConsume(`${WEBSOCKET_PATH}?afterSequence=1`))
      .toEqual({ kind: "absent" });
    expect(verifier.verifyAndConsume(DETACHED_RUNTIME_WEBSOCKET_PATH))
      .toEqual({ kind: "rejected", reason: "invalid" });
    expect(verifier.verifyAndConsume(undefined))
      .toEqual({ kind: "rejected", reason: "invalid" });
    expect(verifier.verifyAndConsume(DETACHED_RUNTIME_WEBSOCKET_PATH.slice(1)))
      .toEqual({ kind: "rejected", reason: "invalid" });
  });

  it("enforces expiry, maximum future lifetime, and bounded replay storage", () => {
    let now = INITIAL_NOW;
    const verifier = registry({
      now: () => now,
      maxCapabilityTtlMs: 5_000,
      maxConsumedNonces: 1,
    });
    const first = mint({ ttlMs: 1_000, entropyByte: 10 });
    const whileFull = mint({ ttlMs: 5_000, entropyByte: 11 });

    expect(verifier.verifyAndConsume(requestUrl(first)).kind).toBe("accepted");
    expect(verifier.verifyAndConsume(requestUrl(whileFull)))
      .toEqual({ kind: "rejected", reason: "capacity" });

    now += 1_001;
    const afterPrune = mint({
      now,
      ttlMs: 5_000,
      entropyByte: 12,
    });
    expect(verifier.verifyAndConsume(requestUrl(afterPrune)).kind).toBe("accepted");

    const expiredVerifier = registry({ now: () => INITIAL_NOW + 1_000 });
    expect(expiredVerifier.verifyAndConsume(requestUrl(first)))
      .toEqual({ kind: "rejected", reason: "expired" });

    const excessiveFuture = mint({
      ttlMs: MAX_DETACHED_RUNTIME_CAPABILITY_TTL_MS,
      entropyByte: 13,
    });
    expect(verifier.verifyAndConsume(requestUrl(excessiveFuture)))
      .toEqual({ kind: "rejected", reason: "invalid" });
  });

  it("rotates validity when the base runtime bearer URL changes", () => {
    const priorGeneration = mint();
    const nextGenerationSecret = BASE_URL.replace("48123", "48124");
    const nextGeneration = registry({ secret: nextGenerationSecret });

    expect(nextGeneration.verifyAndConsume(requestUrl(priorGeneration)))
      .toEqual({ kind: "rejected", reason: "invalid" });
  });
});
