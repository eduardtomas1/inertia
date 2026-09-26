import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { clearTextSendIdentity, prepareTextSendIdentity } from "../../src/renderer/src/lib/messageSendIdentity";

function fixtureStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    key: (index) => [...values.keys()][index] ?? null,
  };
}

const message = () => ({ conversationId: randomUUID(), content: "private prompt text", attachments: [], activate: true });

describe("text send identities across renderer reloads", () => {
  it("reuses an unresolved send after reconstructing its payload without persisting prompt text", async () => {
    const storage = fixtureStorage();
    const payload = message();
    const first = await prepareTextSendIdentity(storage, payload, randomUUID());
    const restoredPayload = structuredClone(payload);
    expect(await prepareTextSendIdentity(storage, restoredPayload, randomUUID())).toBe(first);
    const saved = storage.getItem(storage.key(0)!)!;
    expect(saved).toContain(first);
    expect(saved).not.toContain(payload.content);
    expect(await prepareTextSendIdentity(storage, { ...payload, content: "a different message" }, randomUUID())).not.toBe(first);
    expect(await prepareTextSendIdentity(storage, { ...payload, conversationId: randomUUID() }, randomUUID())).not.toBe(first);
  });

  it("allows the same text as a new send after its acknowledgement is cleared", async () => {
    const storage = fixtureStorage();
    const payload = message();
    const first = await prepareTextSendIdentity(storage, payload, randomUUID());
    const otherPayload = { ...payload, content: "another pending message" };
    const other = await prepareTextSendIdentity(storage, otherPayload, randomUUID());
    clearTextSendIdentity(storage, payload.conversationId, first);
    expect(await prepareTextSendIdentity(storage, payload, randomUUID())).not.toBe(first);
    expect(await prepareTextSendIdentity(storage, otherPayload, randomUUID())).toBe(other);
  });

  it.each(["not json", '{"invalid":true}', '[{"fingerprint":"invalid","requestId":"invalid"}]'])("fails closed for corrupt saved identities: %s", async (corrupt) => {
    const storage = fixtureStorage();
    const payload = message();
    await prepareTextSendIdentity(storage, payload, randomUUID());
    const key = storage.key(0)!;
    storage.setItem(key, corrupt);
    await expect(prepareTextSendIdentity(storage, payload, randomUUID())).rejects.toThrow();
    expect(storage.getItem(key)).toBe(corrupt);
  });
});
