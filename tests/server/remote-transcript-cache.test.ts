import { describe, expect, it } from "vitest";

import {
  REMOTE_TRANSCRIPT_CACHE_BUDGET_BYTES,
  RemoteTranscriptCache,
  remoteTranscriptFingerprint,
} from "../../src/server/remote-transcript-cache";
import { sanitizeRemoteContent } from "../../src/shared/remote-sanitizer";

const MEGABYTE = 1024 * 1024;

function multiMegabyteMessage(index: number): string {
  return `Answer ${index}. ${"prose ".repeat(MEGABYTE / 3)}`;
}

describe("remote transcript cache", () => {
  it("keeps retained memory under the budget for hundreds of huge messages", () => {
    const cache = new RemoteTranscriptCache();
    for (let index = 0; index < 300; index += 1) {
      cache.content("conversation", `message-${index}`, multiMegabyteMessage(index));
      expect(cache.retainedBytes()).toBeLessThanOrEqual(
        REMOTE_TRANSCRIPT_CACHE_BUDGET_BYTES,
      );
    }
    expect(cache.retainedBytes()).toBeLessThanOrEqual(
      REMOTE_TRANSCRIPT_CACHE_BUDGET_BYTES,
    );
    expect(cache.size()).toBeLessThan(300);
  });

  it("evicts the least recently used entry when the budget is exceeded", () => {
    const sanitized: string[] = [];
    const entryCost = 96 + 2 * (400 + 64 + "1:cfirst".length);
    const cache = new RemoteTranscriptCache({
      budgetBytes: entryCost * 2,
      sanitize: (source) => {
        sanitized.push(source.slice(0, 5));
        return source;
      },
    });
    const body = (label: string): string => label.padEnd(400, "x");
    cache.content("c", "first", body("first"));
    cache.content("c", "secnd", body("secnd"));
    expect(cache.size()).toBe(2);

    cache.content("c", "first", body("first"));
    cache.content("c", "third", body("third"));
    expect(cache.size()).toBe(2);
    expect(cache.retainedBytes()).toBeLessThanOrEqual(entryCost * 2);
    expect(sanitized).toEqual(["first", "secnd", "third"]);

    cache.content("c", "first", body("first"));
    expect(sanitized).toEqual(["first", "secnd", "third"]);
    cache.content("c", "secnd", body("secnd"));
    expect(sanitized).toEqual(["first", "secnd", "third", "secnd"]);
  });

  it("returns the correct sanitized content on a cache hit", () => {
    let sanitizeCalls = 0;
    const cache = new RemoteTranscriptCache({
      sanitize: (source) => {
        sanitizeCalls += 1;
        return sanitizeRemoteContent(source);
      },
    });
    const source = "Look at /Users/someone/secret.txt and sk-abcdefghijklmnop";
    const first = cache.content("c", "m", source);
    const second = cache.content("c", "m", source);
    expect(second).toBe(first);
    expect(sanitizeCalls).toBe(1);
    expect(first).toBe(sanitizeRemoteContent(source));
    expect(first).not.toContain("/Users/someone");
  });

  it("invalidates stale output when a message is replaced", () => {
    const cache = new RemoteTranscriptCache();
    const first = cache.content("c", "m", "original answer");
    const second = cache.content("c", "m", "edited answer");
    expect(first).toBe("original answer");
    expect(second).toBe("edited answer");
    expect(cache.content("c", "m", "edited answer")).toBe("edited answer");
  });

  it("does not confuse messages whose inspected prefixes differ later on", () => {
    const cache = new RemoteTranscriptCache();
    const shared = "shared opening. ".repeat(100);
    const withSecret = `${shared} token_abcdefghijklmnop`;
    const withoutSecret = `${shared} ordinary trailing prose`;
    const redacted = cache.content("c", "m", withSecret);
    const plain = cache.content("c", "m", withoutSecret);
    expect(redacted).toContain("<redacted-secret>");
    expect(plain).not.toContain("<redacted-secret>");
    expect(plain).toContain("ordinary trailing prose");
  });

  it("fingerprints only the bounded window the sanitizer inspects", () => {
    const prefix = "a".repeat(80 * 1024);
    expect(remoteTranscriptFingerprint(`${prefix}beyond-window-one`))
      .toBe(remoteTranscriptFingerprint(`${prefix}beyond-window-two`));
    expect(remoteTranscriptFingerprint("short"))
      .not.toBe(remoteTranscriptFingerprint("shorter"));
  });

  it("does not let a shorter window collide with a longer one", () => {
    expect(remoteTranscriptFingerprint("12ab"))
      .not.toBe(remoteTranscriptFingerprint("2ab"));
  });

  it("separates identical message ids across different conversations", () => {
    const cache = new RemoteTranscriptCache();
    expect(cache.content("alpha", "m", "from alpha")).toBe("from alpha");
    expect(cache.content("beta", "m", "from beta")).toBe("from beta");
    expect(cache.content("alpha", "m", "from alpha")).toBe("from alpha");
    expect(cache.size()).toBe(2);
  });

  it("cannot be made to collide by identifiers that contain the separator", () => {
    const cache = new RemoteTranscriptCache();
    cache.content("a", "b:c", "first");
    cache.content("a:b", "c", "second");
    expect(cache.size()).toBe(2);
    expect(cache.content("a", "b:c", "first")).toBe("first");
    expect(cache.content("a:b", "c", "second")).toBe("second");
  });

  it("clears a single conversation without touching its neighbours", () => {
    const cache = new RemoteTranscriptCache();
    cache.content("keep", "m", "kept");
    cache.content("drop", "m", "dropped");
    cache.invalidateConversation("drop");
    expect(cache.size()).toBe(1);
    expect(cache.retainedBytes()).toBeGreaterThan(0);
    cache.invalidateConversation("keep");
    expect(cache.size()).toBe(0);
    expect(cache.retainedBytes()).toBe(0);
  });

  it("only clears conversations whose full identifier matches", () => {
    const cache = new RemoteTranscriptCache();
    cache.content("conversation", "m", "outer");
    cache.content("conversation-extra", "m", "sibling");
    cache.invalidateConversation("conversation");
    expect(cache.size()).toBe(1);
    expect(cache.content("conversation-extra", "m", "sibling")).toBe("sibling");
  });

  it("clears a single message", () => {
    const cache = new RemoteTranscriptCache();
    cache.content("c", "one", "first");
    cache.content("c", "two", "second");
    cache.invalidateMessage("c", "one");
    expect(cache.size()).toBe(1);
  });

  it("drops every retained byte when cleared", () => {
    const cache = new RemoteTranscriptCache();
    cache.content("c", "m", "sensitive prose");
    expect(cache.retainedBytes()).toBeGreaterThan(0);
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.retainedBytes()).toBe(0);
  });

  it("never retains an entry larger than the whole budget", () => {
    const cache = new RemoteTranscriptCache({ budgetBytes: 128 });
    const value = cache.content("c", "m", "x".repeat(4_096));
    expect(value).toBe("x".repeat(4_096));
    expect(cache.size()).toBe(0);
    expect(cache.retainedBytes()).toBe(0);
  });

  it("keeps the byte total consistent across mixed operations", () => {
    const cache = new RemoteTranscriptCache({ budgetBytes: 100_000 });
    for (let index = 0; index < 50; index += 1) {
      cache.content("c", `m-${index % 10}`, "y".repeat(index * 10));
    }
    cache.invalidateConversation("c");
    expect(cache.size()).toBe(0);
    expect(cache.retainedBytes()).toBe(0);
  });
});
