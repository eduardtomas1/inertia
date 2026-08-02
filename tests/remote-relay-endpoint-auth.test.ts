import {
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { chmod, mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EndpointAuthenticator,
  EndpointBindingStore,
  endpointProofTranscript,
  verifyEndpointProof,
  type EndpointChallenge,
  type EndpointProof,
} from "../remote/relay/endpoint-auth.mjs";

const temporaryDirectories: string[] = [];

function endpointKeys(): { publicKey: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString(
      "base64url",
    ),
    privateKey,
  };
}

function proof(
  challenge: EndpointChallenge,
  privateKey: KeyObject,
): EndpointProof {
  return {
    type: "relay.register.proof",
    ...challenge,
    signature: sign(
      "sha256",
      endpointProofTranscript(challenge),
      { key: privateKey, dsaEncoding: "ieee-p1363" },
    ).toString("base64url"),
  };
}

async function stateDirectory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "inertia-relay-auth-"));
  temporaryDirectories.push(value);
  return value;
}

async function store(
  directory: string,
  now: () => number = () => Date.parse("2026-08-01T12:00:00.000Z"),
): Promise<EndpointBindingStore> {
  return await EndpointBindingStore.open({
    stateDirectory: directory,
    initialize: true,
    now,
  });
}

function expectChallenge(
  result: Awaited<ReturnType<EndpointAuthenticator["beginClaim"]>>,
): EndpointChallenge {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Expected a challenge, received ${result.code}.`);
  return result.challenge;
}

async function claimedFixture(options?: {
  now?: () => number;
  directory?: string;
}) {
  const directory = options?.directory ?? await stateDirectory();
  const now = options?.now ?? (() => Date.parse("2026-08-01T12:00:00.000Z"));
  const bindingStore = await store(directory, now);
  const keys = endpointKeys();
  const authenticator = new EndpointAuthenticator({ store: bindingStore, now });
  const challenge = expectChallenge(await authenticator.beginClaim({
    socketId: "claim-socket",
    source: "127.0.0.1",
    endpointId: "fresh_endpoint",
    endpointPublicKey: keys.publicKey,
  }));
  const claimed = await authenticator.prove(
    "claim-socket",
    "127.0.0.1",
    proof(challenge, keys.privateKey),
  );
  expect(claimed).toMatchObject({
    ok: true,
    ownership: "claimed",
    binding: { epoch: 1, endpointId: "fresh_endpoint" },
  });
  return { directory, now, bindingStore, keys, authenticator };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Remote Companion relay endpoint authentication", () => {
  it("signs an unambiguous challenge transcript with a dedicated P-256 key", () => {
    const keys = endpointKeys();
    const challenge: EndpointChallenge = {
      purpose: "claim",
      relayIdentity: "189dd54b-655b-4f8a-ae52-d90531c829c9",
      endpointId: "endpoint_A",
      endpointPublicKey: keys.publicKey,
      nonce: Buffer.alloc(32, 7).toString("base64url"),
      epoch: 1,
      expiresAt: 1_785_585_605_000,
    };
    const signed = proof(challenge, keys.privateKey);

    expect(verifyEndpointProof(challenge, signed.signature)).toBe(true);
    expect(verifyEndpointProof(
      { ...challenge, endpointId: "endpoint_B" },
      signed.signature,
    )).toBe(false);
    expect(verifyEndpointProof(
      { ...challenge, epoch: 2 },
      signed.signature,
    )).toBe(false);
    expect(endpointProofTranscript({
      ...challenge,
      endpointId: "ab",
    })).not.toEqual(endpointProofTranscript({
      ...challenge,
      endpointId: "a",
      nonce: Buffer.concat([Buffer.from("b"), Buffer.alloc(31, 7)]).toString(
        "base64url",
      ),
    }));
  });

  it("persists the first claim and advances its epoch across relay restart", async () => {
    let clock = Date.parse("2026-08-01T12:00:00.000Z");
    const fixture = await claimedFixture({ now: () => clock });
    const firstRelayIdentity = fixture.bindingStore.relayIdentity;
    clock += 1_000;

    const restartedStore = await EndpointBindingStore.open({
      stateDirectory: fixture.directory,
      now: () => clock,
    });
    expect(restartedStore.relayIdentity).toBe(firstRelayIdentity);
    expect(await restartedStore.get("fresh_endpoint")).toMatchObject({
      epoch: 1,
      endpointPublicKey: fixture.keys.publicKey,
    });

    const restarted = new EndpointAuthenticator({
      store: restartedStore,
      now: () => clock,
    });
    const challenge = expectChallenge(await restarted.beginRegistration({
      socketId: "reconnect-socket",
      source: "127.0.0.1",
      endpointId: "fresh_endpoint",
    }));
    expect(challenge).toMatchObject({
      purpose: "register",
      relayIdentity: firstRelayIdentity,
      epoch: 2,
    });

    const registeredProof = proof(challenge, fixture.keys.privateKey);
    expect(await restarted.prove(
      "reconnect-socket",
      "127.0.0.1",
      registeredProof,
    )).toMatchObject({
      ok: true,
      ownership: "verified",
      binding: { epoch: 2 },
    });
    expect(await restarted.prove(
      "reconnect-socket",
      "127.0.0.1",
      registeredProof,
    )).toEqual({ ok: false, code: "invalid-message" });
  });

  it("allows exactly one winner when valid reconnects race for an epoch", async () => {
    const fixture = await claimedFixture();
    const first = expectChallenge(await fixture.authenticator.beginRegistration({
      socketId: "racing-socket-1",
      source: "127.0.0.1",
      endpointId: "fresh_endpoint",
    }));
    const second = expectChallenge(await fixture.authenticator.beginRegistration({
      socketId: "racing-socket-2",
      source: "127.0.0.2",
      endpointId: "fresh_endpoint",
    }));
    expect(first.epoch).toBe(2);
    expect(second.epoch).toBe(2);

    const outcomes = await Promise.all([
      fixture.authenticator.prove(
        "racing-socket-1",
        "127.0.0.1",
        proof(first, fixture.keys.privateKey),
      ),
      fixture.authenticator.prove(
        "racing-socket-2",
        "127.0.0.2",
        proof(second, fixture.keys.privateKey),
      ),
    ]);

    expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
    expect(outcomes.filter((result) => !result.ok)).toEqual([
      { ok: false, code: "endpoint-owned" },
    ]);
    expect(await fixture.bindingStore.get("fresh_endpoint")).toMatchObject({
      epoch: 2,
    });
  });

  it("consumes altered and expired challenges before signature verification", async () => {
    let clock = Date.parse("2026-08-01T12:00:00.000Z");
    const bindingStore = await store(await stateDirectory(), () => clock);
    const keys = endpointKeys();
    const verifyProof = vi.fn(() => true);
    const authenticator = new EndpointAuthenticator({
      store: bindingStore,
      now: () => clock,
      verifyProof,
    });
    const alteredChallenge = expectChallenge(await authenticator.beginClaim({
      socketId: "altered-socket",
      source: "127.0.0.1",
      endpointId: "altered_endpoint",
      endpointPublicKey: keys.publicKey,
    }));
    const alteredProof = proof(alteredChallenge, keys.privateKey);
    alteredProof.nonce = Buffer.alloc(32, 9).toString("base64url");
    expect(await authenticator.prove(
      "altered-socket",
      "127.0.0.1",
      alteredProof,
    )).toEqual({ ok: false, code: "invalid-message" });
    expect(await authenticator.prove(
      "altered-socket",
      "127.0.0.1",
      proof(alteredChallenge, keys.privateKey),
    )).toEqual({ ok: false, code: "invalid-message" });

    const expiredChallenge = expectChallenge(await authenticator.beginClaim({
      socketId: "expired-socket",
      source: "127.0.0.2",
      endpointId: "expired_endpoint",
      endpointPublicKey: keys.publicKey,
    }));
    clock += 5_001;
    expect(await authenticator.prove(
      "expired-socket",
      "127.0.0.2",
      proof(expiredChallenge, keys.privateKey),
    )).toEqual({ ok: false, code: "challenge-expired" });
    expect(verifyProof).not.toHaveBeenCalled();
  });

  it("applies source and endpoint failure limits before further proof work", async () => {
    let clock = Date.parse("2026-08-01T12:00:00.000Z");
    const bindingStore = await store(await stateDirectory(), () => clock);
    const keys = endpointKeys();
    const verifyProof = vi.fn(() => false);
    const authenticator = new EndpointAuthenticator({
      store: bindingStore,
      now: () => clock,
      verifyProof,
      maxIpFailures: 1,
      maxEndpointFailures: 1,
    });
    const challenge = expectChallenge(await authenticator.beginClaim({
      socketId: "failed-socket",
      source: "198.51.100.8",
      endpointId: "limited_endpoint",
      endpointPublicKey: keys.publicKey,
    }));
    const invalidProof: EndpointProof = {
      type: "relay.register.proof",
      ...challenge,
      signature: Buffer.alloc(64).toString("base64url"),
    };
    expect(await authenticator.prove(
      "failed-socket",
      "198.51.100.8",
      invalidProof,
    )).toEqual({ ok: false, code: "proof-invalid" });
    expect(verifyProof).toHaveBeenCalledTimes(1);

    expect(await authenticator.beginClaim({
      socketId: "blocked-source",
      source: "198.51.100.8",
      endpointId: "another_endpoint",
      endpointPublicKey: keys.publicKey,
    })).toEqual({ ok: false, code: "rate-limited" });
    expect(await authenticator.beginClaim({
      socketId: "blocked-endpoint",
      source: "198.51.100.9",
      endpointId: "limited_endpoint",
      endpointPublicKey: keys.publicKey,
    })).toEqual({ ok: false, code: "rate-limited" });
    expect(verifyProof).toHaveBeenCalledTimes(1);

    clock += 60_001;
    expect((await authenticator.beginClaim({
      socketId: "rate-window-recovered",
      source: "198.51.100.8",
      endpointId: "limited_endpoint",
      endpointPublicKey: keys.publicKey,
    })).ok).toBe(true);
  });

  it("rate-limits valid first claims before consuming durable slots", async () => {
    let clock = Date.parse("2026-08-01T12:00:00.000Z");
    const bindingStore = await store(await stateDirectory(), () => clock);
    const authenticator = new EndpointAuthenticator({
      store: bindingStore,
      now: () => clock,
      maxClaimsPerSourcePerMinute: 1,
    });
    const source = "198.51.100.21";
    const firstKeys = endpointKeys();
    const first = expectChallenge(await authenticator.beginClaim({
      socketId: "first-valid-claim",
      source,
      endpointId: "first_limited_claim",
      endpointPublicKey: firstKeys.publicKey,
    }));
    expect(await authenticator.prove(
      "first-valid-claim",
      source,
      proof(first, firstKeys.privateKey),
    )).toMatchObject({ ok: true, ownership: "claimed" });

    const secondKeys = endpointKeys();
    const second = expectChallenge(await authenticator.beginClaim({
      socketId: "second-valid-claim",
      source,
      endpointId: "second_limited_claim",
      endpointPublicKey: secondKeys.publicKey,
    }));
    expect(await authenticator.prove(
      "second-valid-claim",
      source,
      proof(second, secondKeys.privateKey),
    )).toEqual({ ok: false, code: "rate-limited" });
    expect(await bindingStore.get("second_limited_claim")).toBeNull();

    clock += 60_001;
    const recovered = expectChallenge(await authenticator.beginClaim({
      socketId: "recovered-valid-claim",
      source,
      endpointId: "second_limited_claim",
      endpointPublicKey: secondKeys.publicKey,
    }));
    expect(await authenticator.prove(
      "recovered-valid-claim",
      source,
      proof(recovered, secondKeys.privateKey),
    )).toMatchObject({ ok: true, ownership: "claimed" });
  });

  it("rejects a squatter without the endpoint key and preserves the endpoint", async () => {
    const fixture = await claimedFixture();
    const attackerKeys = endpointKeys();
    const challenge = expectChallenge(await fixture.authenticator.beginRegistration({
      socketId: "attacker-socket",
      source: "203.0.113.10",
      endpointId: "fresh_endpoint",
    }));
    expect(await fixture.authenticator.prove(
      "attacker-socket",
      "203.0.113.10",
      proof(challenge, attackerKeys.privateKey),
    )).toEqual({ ok: false, code: "proof-invalid" });
    expect(await fixture.bindingStore.get("fresh_endpoint")).toMatchObject({
      epoch: 1,
      endpointPublicKey: fixture.keys.publicKey,
    });
  });

  it("fails closed when a known durable binding disappears", async () => {
    const fixture = await claimedFixture();
    const endpointDirectory = join(fixture.directory, "endpoints");
    const records = await readdir(endpointDirectory);
    expect(records).toHaveLength(1);
    await unlink(join(endpointDirectory, records[0]!));

    await expect(EndpointBindingStore.open({
      stateDirectory: fixture.directory,
    })).rejects.toThrow("known relay endpoint binding record is missing");
  });

  it.runIf(process.platform !== "win32")(
    "rejects a durable state directory that is not owner-writable",
    async () => {
      const directory = await stateDirectory();
      await store(directory);
      await chmod(directory, 0o500);
      try {
        await expect(EndpointBindingStore.open({
          stateDirectory: directory,
        })).rejects.toThrow("must be writable by its owner");
      } finally {
        await chmod(directory, 0o700);
      }
    },
  );
});
