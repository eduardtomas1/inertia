import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentPreparationOperation, DocumentPreparationResult } from "../../src/node/document-preparation";
import { RuntimeDocumentPreparationClient } from "../../src/server/runtime/attachments/document-preparation-client";
import type { RuntimeDocumentPreparationEvent, RuntimeDocumentPreparationResult } from "../../src/node/runtime-document-preparation-protocol";

const operation = (): DocumentPreparationOperation => ({ deadlineAt: Date.now() + 1_000,
  payloads: [{ id: "pdf", name: "Notes.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1]) }] });
const result: DocumentPreparationResult = { contexts: [{ attachmentId: "pdf", label: "PDF", content: "Notes", truncated: false }], images: [], imageOrder: [] };

function fixture() {
  const events: RuntimeDocumentPreparationEvent[] = [];
  const client = new RuntimeDocumentPreparationClient((event) => { events.push(event); });
  const reply = (index = 0, confirmed = true): RuntimeDocumentPreparationResult => ({
    type: "runtime.document-preparation-result", requestId: events[index]!.requestId,
    ok: false, shutdownConfirmed: confirmed, message: "Stopped",
  });
  return { events, client, reply };
}

afterEach(() => { vi.useRealTimers(); });

describe("document decoder broker client", () => {
  it("correlates successful results and requires a matching document identity", async () => {
    const { client, events } = fixture();
    const execution = client.runner(operation());
    expect(client.handle({ type: "runtime.document-preparation-result", requestId: crypto.randomUUID(), ok: true, shutdownConfirmed: true, result })).toBe(false);
    client.handle({ type: "runtime.document-preparation-result", requestId: events[0]!.requestId, ok: true, shutdownConfirmed: true, result });
    await expect(execution.result).resolves.toEqual(result);
    await expect(execution.stopped).resolves.toBeUndefined();
    const next = client.runner(operation());
    client.handle({ type: "runtime.document-preparation-result", requestId: events[1]!.requestId, ok: true, shutdownConfirmed: true,
      result: { ...result, contexts: [{ ...result.contexts[0]!, attachmentId: "foreign" }] } });
    await expect(next.result).rejects.toThrow("unrelated");
    await expect(next.stopped).resolves.toBeUndefined();
  });

  it.each(["abort", "deadline", "close"] as const)("does not invent exit proof after %s", async (mode) => {
    vi.useFakeTimers();
    const { client, events, reply } = fixture();
    const controller = new AbortController();
    const execution = client.runner(operation(), controller.signal);
    const rejected = expect(execution.result).rejects.toThrow(/cancelled|deadline|stopped/u);
    let exited = false;
    void execution.stopped.then(() => { exited = true; });
    if (mode === "abort") controller.abort();
    else if (mode === "deadline") await vi.advanceTimersByTimeAsync(1_000);
    else client.close();
    await rejected;
    expect(events.at(-1)).toEqual({ type: "runtime.document-preparation-cancel", requestId: events[0]!.requestId });
    expect(exited).toBe(false);
    client.handle(reply());
    await expect(execution.stopped).resolves.toBeUndefined();
    await expect(execution.termination).resolves.toBeUndefined();
  });

  it("retains unconfirmed cleanup even if posting the request throws", async () => {
    const client = new RuntimeDocumentPreparationClient(() => { throw new Error("Transport failed"); });
    const execution = client.runner(operation());
    let terminated = false;
    void execution.termination.then(() => { terminated = true; });
    await Promise.all([expect(execution.result).rejects.toThrow("could not be delivered"),
      expect(execution.stopped).rejects.toThrow("unconfirmed")]);
    expect(terminated).toBe(false);
  });

  it("rejects a reported unconfirmed stop without claiming actual termination", async () => {
    const { client, reply } = fixture();
    const execution = client.runner(operation());
    client.handle(reply(0, false));
    await Promise.all([expect(execution.result).rejects.toThrow("Stopped"),
      expect(execution.stopped).rejects.toThrow("unconfirmed")]);
  });

  it("rejects expired, cancelled, invalid, and closed requests before posting", async () => {
    const { client, events } = fixture();
    const controller = new AbortController();
    controller.abort();
    const executions = [client.runner({ ...operation(), deadlineAt: Date.now() }),
      client.runner(operation(), controller.signal), client.runner({ ...operation(), payloads: [] })];
    client.close();
    executions.push(client.runner(operation()));
    for (const execution of executions) {
      await expect(execution.result).rejects.toThrow("unavailable or cancelled");
      await expect(execution.stopped).resolves.toBeUndefined();
    }
    expect(events).toEqual([]);
  });

  it("bounds pending requests and holds their capacity until exit acknowledgement", async () => {
    const { client, events, reply } = fixture();
    const running = Array.from({ length: 3 }, () => client.runner(operation()));
    const refused = client.runner(operation());
    await expect(refused.result).rejects.toThrow("unavailable");
    expect(events).toHaveLength(3);
    const outcomes = running.map((execution) => expect(execution.result).rejects.toThrow("stopped"));
    client.close();
    await Promise.all(outcomes);
    running.forEach((_, index) => client.handle(reply(index)));
    await Promise.all(running.map((execution) => execution.stopped));
  });
});
