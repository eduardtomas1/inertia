import { describe, expect, it } from "vitest";

import {
  normalizeRemoteConversationGrants,
  remoteConversationGrantsFromProjectIds,
  REMOTE_GRANT_LIMITS,
  remoteGrantAllowsConversation,
  remoteGrantedProjectIds,
  sameRemoteConversationGrants,
  type RemoteConversationGrant,
} from "../../src/shared/remote-grants";
import {
  remotePromptSafetyForHarness,
  remotePromptSafetyIsUsable,
} from "../../src/shared/remote-prompt-safety";
import {
  remoteCipherFrameSchema,
  remoteRequestSchema,
  remoteAuthorizationSubjectSchema,
  remoteConversationGrantsSchema,
  REMOTE_BROWSER_VERSION,
  REMOTE_LIMITS,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_RELAY_VERSION,
} from "../../src/shared/remote-protocol";
import {
  remoteSanitizerInspectionWindow,
  sanitizeRemoteContent,
  sanitizeRemoteLabel,
} from "../../src/shared/remote-sanitizer";
import { remoteTranscriptFingerprint } from "../../src/server/remote-transcript-cache";
import { normalizeIdentityPath } from "../../src/server/project-identity";

function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

const ALPHABET = "ab/\\:.-_ \n\t<>\"'`$#{}[]()0123456789 \u0000\u202e\u200f`~";

function fuzzString(random: () => number, maximum = 120): string {
  const length = Math.floor(random() * maximum);
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += ALPHABET[Math.floor(random() * ALPHABET.length)];
  }
  return value;
}

function fuzzJson(random: () => number, depth = 0): unknown {
  const choice = Math.floor(random() * (depth > 2 ? 4 : 7));
  if (choice === 0) return null;
  if (choice === 1) return fuzzString(random, 20);
  if (choice === 2) return Math.floor(random() * 1e6) - 5e5;
  if (choice === 3) return random() < 0.5;
  if (choice === 4) {
    return Array.from(
      { length: Math.floor(random() * 4) },
      () => fuzzJson(random, depth + 1),
    );
  }
  const keys = ["type", "kind", "requestId", "sessionId", "sequence", "grants"];
  const value: Record<string, unknown> = {};
  for (const key of keys) {
    if (random() < 0.5) value[key] = fuzzJson(random, depth + 1);
  }
  return value;
}

describe("remote frame and request parsing never yields authority", () => {
  it("versions the prompt-safety projection protocol coherently", () => {
    expect(REMOTE_PROTOCOL_VERSION).toBe(2);
    expect(REMOTE_BROWSER_VERSION).toBe("0.2.0");
    expect(REMOTE_RELAY_VERSION).toBe("0.2.0");
  });

  it("rejects malformed frames without throwing", () => {
    const random = seeded(0xc0ffee);
    for (let attempt = 0; attempt < 3_000; attempt += 1) {
      const candidate = fuzzJson(random);
      const frame = remoteCipherFrameSchema.safeParse(candidate);
      if (frame.success) {
        expect(frame.data.protocolVersion).toBe(2);
        expect(typeof frame.data.kind).toBe("string");
      }
      const request = remoteRequestSchema.safeParse(candidate);
      if (request.success) {
        expect(["state.get", "conversation.get", "prompt.send"])
          .toContain(request.data.type);
      }
      const subject = remoteAuthorizationSubjectSchema.safeParse(candidate);
      if (subject.success) {
        expect(subject.data.scopes.length).toBeGreaterThan(0);
        expect(subject.data.projectIds.length).toBeGreaterThan(0);
      }
    }
  });

  it("never accepts a sequence outside the protocol bound", () => {
    const base = {
      protocolVersion: 2,
      kind: "session.data",
      sessionId: "7f0c11aa-9ee8-4e3c-8f8f-0907e31b389e",
      ciphertext: "AAAA",
    };
    for (const sequence of [
      -1, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 2, "0", null,
    ]) {
      expect(remoteCipherFrameSchema.safeParse({ ...base, sequence }).success)
        .toBe(false);
    }
    expect(remoteCipherFrameSchema.safeParse({ ...base, sequence: 0 }).success)
      .toBe(true);
    expect(remoteCipherFrameSchema.safeParse({
      ...base,
      sequence: Number.MAX_SAFE_INTEGER,
    }).success).toBe(true);
  });

  it("never accepts an oversized ciphertext or prompt", () => {
    expect(remoteCipherFrameSchema.safeParse({
      protocolVersion: 2,
      kind: "session.data",
      sessionId: "7f0c11aa-9ee8-4e3c-8f8f-0907e31b389e",
      sequence: 0,
      ciphertext: "A".repeat(REMOTE_LIMITS.encryptedFrameBytes + 1),
    }).success).toBe(false);
    expect(remoteRequestSchema.safeParse({
      type: "prompt.send",
      requestId: "7f0c11aa-9ee8-4e3c-8f8f-0907e31b389e",
      deliveryId: "7f0c11aa-9ee8-4e3c-8f8f-0907e31b389f",
      conversationId: "7f0c11aa-9ee8-4e3c-8f8f-0907e31b3891",
      content: "x".repeat(REMOTE_LIMITS.promptCharacters + 1),
    }).success).toBe(false);
  });

  it("rejects extra fields on every frame shape", () => {
    expect(remoteCipherFrameSchema.safeParse({
      protocolVersion: 2,
      kind: "session.close",
      sessionId: "7f0c11aa-9ee8-4e3c-8f8f-0907e31b389e",
      reason: "revoked",
      sourcePath: "/Users/alice/secret",
    }).success).toBe(false);
  });
});

describe("grant serialization and migration properties", () => {
  it("normalization is idempotent and never widens authority", () => {
    const random = seeded(0xbeef);
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const grants: RemoteConversationGrant[] = Array.from(
        { length: Math.floor(random() * 5) },
        () => ({
          projectId: fuzzString(random, 12),
          conversationIds: Array.from(
            { length: Math.floor(random() * 5) },
            () => fuzzString(random, 8),
          ),
          includeFutureConversations: random() < 0.3,
          legacyProjectWide: random() < 0.2,
        }),
      );
      const once = normalizeRemoteConversationGrants(grants);
      const twice = normalizeRemoteConversationGrants(once);
      expect(sameRemoteConversationGrants(once, twice)).toBe(true);
      expect(once.length).toBeLessThanOrEqual(REMOTE_GRANT_LIMITS.projects);
      for (const grant of once) {
        expect(grant.projectId.trim()).toBe(grant.projectId);
        expect(grant.projectId.length).toBeGreaterThan(0);
        expect(grant.conversationIds.length)
          .toBeLessThanOrEqual(REMOTE_GRANT_LIMITS.conversationsPerProject);
        expect(new Set(grant.conversationIds).size)
          .toBe(grant.conversationIds.length);
      }
      expect(remoteGrantedProjectIds(once).length).toBe(once.length);
    }
  });

  it("a conversation is inaccessible unless explicitly granted", () => {
    const random = seeded(0x1234);
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const projectId = `p${Math.floor(random() * 5)}`;
      const conversationId = `c${Math.floor(random() * 5)}`;
      const grants = normalizeRemoteConversationGrants([{
        projectId: `p${Math.floor(random() * 5)}`,
        conversationIds: [`c${Math.floor(random() * 5)}`],
        includeFutureConversations: false,
        legacyProjectWide: false,
      }]);
      const allowed = remoteGrantAllowsConversation(
        grants,
        projectId,
        conversationId,
      );
      const grant = grants.find((entry) => entry.projectId === projectId);
      expect(allowed).toBe(
        Boolean(grant?.conversationIds.includes(conversationId)),
      );
    }
  });

  it("malformed grant data never parses into authority", () => {
    const random = seeded(0x777);
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const parsed = remoteConversationGrantsSchema.safeParse(fuzzJson(random));
      if (!parsed.success) continue;
      for (const grant of parsed.data) {
        expect(typeof grant.projectId).toBe("string");
        expect(typeof grant.includeFutureConversations).toBe("boolean");
        expect(typeof grant.legacyProjectWide).toBe("boolean");
      }
    }
  });

  it("legacy migration preserves exactly the previous project reach", () => {
    const random = seeded(0x99);
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const projectIds = Array.from(
        { length: 1 + Math.floor(random() * 4) },
        () => `p${Math.floor(random() * 6)}`,
      );
      const grants = remoteConversationGrantsFromProjectIds(projectIds);
      expect(remoteGrantedProjectIds(grants))
        .toEqual([...new Set(projectIds)].sort());
      for (const projectId of new Set(projectIds)) {
        expect(remoteGrantAllowsConversation(grants, projectId, "anything"))
          .toBe(true);
      }
      expect(remoteGrantAllowsConversation(grants, "never-granted", "x"))
        .toBe(false);
    }
  });
});

describe("sanitizer properties", () => {
  it("stays bounded and drops control characters for any input", () => {
    const random = seeded(0x5eed);
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const source = fuzzString(random, 400);
      const value = sanitizeRemoteContent(source);
      expect(value.length).toBeLessThanOrEqual(64 * 1024);
      expect(value).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u);
      expect(value).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/u);
      const label = sanitizeRemoteLabel(source);
      if (label !== null) {
        expect(label.length).toBeLessThanOrEqual(240);
        expect(label).not.toMatch(/[\u0000-\u001f\u007f]/u);
      }
    }
  });

  it("is deterministic and depends only on the inspected window", () => {
    const random = seeded(0xabc);
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const source = fuzzString(random, 300);
      expect(sanitizeRemoteContent(source)).toBe(sanitizeRemoteContent(source));
      expect(remoteTranscriptFingerprint(source))
        .toBe(remoteTranscriptFingerprint(source));
      const window = remoteSanitizerInspectionWindow(source);
      expect(sanitizeRemoteContent(window)).toBe(sanitizeRemoteContent(source));
    }
  });

  it("bounded input cannot create unbounded retained state", () => {
    const huge = "x".repeat(4 * 1024 * 1024);
    expect(remoteSanitizerInspectionWindow(huge).length)
      .toBeLessThanOrEqual(68 * 1024);
    expect(sanitizeRemoteContent(huge).length).toBeLessThanOrEqual(64 * 1024);
  });
});

describe("provider capability and path normalization fail closed", () => {
  it("treats every unknown harness id as unsupported", () => {
    const random = seeded(0x2468);
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const harnessId = fuzzString(random, 24);
      const safety = remotePromptSafetyForHarness(harnessId);
      if (![
        "codex-app-server", "claude-agent-sdk", "cursor-acp", "opencode-sdk",
      ].includes(harnessId)) {
        expect(remotePromptSafetyIsUsable(safety)).toBe(false);
      }
    }
  });

  it("normalizes project paths deterministically on both platforms", () => {
    const random = seeded(0x13579);
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const path = fuzzString(random, 60);
      for (const platform of ["linux", "win32"] as const) {
        const once = normalizeIdentityPath(path, platform);
        expect(normalizeIdentityPath(once, platform)).toBe(once);
        expect(once).not.toMatch(/\\/u);
      }
    }
  });
});
