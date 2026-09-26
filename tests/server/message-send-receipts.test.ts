import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";
import { MessageSendReceiptRepository } from "../../src/server/persistence/message-send-receipt-repository";
import { messageSendReceiptsMigration } from "../../src/server/persistence/migrations/message-send-receipts";
import { RuntimeRequestError } from "../../src/server/runtime-errors";
import { defineRuntimeCommandHandler } from "../../src/server/runtime/commands/command-router";
import { withMessageSendReceipts } from "../../src/server/runtime/commands/message-send-receipts";

const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
function fixture() {
  const database = new Database(":memory:"); databases.push(database);
  database.exec("CREATE TABLE conversations(id TEXT PRIMARY KEY)");
  database.exec(messageSendReceiptsMigration.up as string);
  const conversationId = randomUUID(); database.prepare("INSERT INTO conversations VALUES (?)").run(conversationId);
  const receipts = new MessageSendReceiptRepository(database);
  const command: Extract<ClientCommand, { type: "message.send" }> = {
    type: "message.send", requestId: randomUUID(), payload: { conversationId, content: "Do this once", attachments: [], activate: false },
  };
  const response: ServerEvent = { type: "request.result", requestId: command.requestId, result: {
    kind: "message.accepted", conversationId, turnId: randomUUID(), userMessageId: randomUUID(), disposition: "new-turn",
  } };
  const send = vi.fn();
  const dispatch = vi.fn(async (publish: (event: ServerEvent) => void) => { publish(response); });
  const handler = withMessageSendReceipts(receipts, (publish) => defineRuntimeCommandHandler(["message.send"], async () => {
    await dispatch(publish); return "handled";
  }), send);
  return { database, receipts, command, response, dispatch, handler, send };
}

describe("stable text message delivery receipts", () => {
  it("replays accepted work after its response is lost without executing it twice", async () => {
    const { handler, command, dispatch, send, response } = fixture();
    send.mockImplementationOnce(() => { throw new Error("socket disappeared"); });
    await expect(handler({} as never, command)).rejects.toMatchObject({ delivery: "ambiguous" });
    await expect(handler({} as never, command)).resolves.toBe("handled");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(expect.anything(), response);
  });

  it("never retries interrupted or concurrently in-flight delivery", async () => {
    const { receipts, handler, command, dispatch } = fixture();
    receipts.begin(command);
    await expect(handler({} as never, command)).rejects.toMatchObject({ delivery: "ambiguous" });
    receipts.recoverInterrupted();
    await expect(handler({} as never, command)).rejects.toMatchObject({ delivery: "ambiguous" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("can explicitly retry a definitive rejection, and never reuses an ID for changed content", async () => {
    const { handler, command, dispatch } = fixture();
    dispatch.mockRejectedValueOnce(new RuntimeRequestError("Provider unavailable"));
    await expect(handler({} as never, command)).rejects.toThrow("Provider unavailable");
    await expect(handler({} as never, command)).resolves.toBe("handled");
    await expect(handler({} as never, { ...command, payload: { ...command.payload, content: "Different intent" } })).rejects.toMatchObject({ delivery: "ambiguous" });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("preserves ambiguity when recording either acceptance or its failure also fails", async () => {
    const { receipts, handler, command, dispatch } = fixture();
    vi.spyOn(receipts, "accept").mockImplementation(() => { throw new Error("SQLITE_FULL"); });
    vi.spyOn(receipts, "fail").mockImplementation(() => { throw new Error("SQLITE_FULL"); });
    await expect(handler({} as never, command)).rejects.toMatchObject({ delivery: "ambiguous" });
    await expect(handler({} as never, command)).rejects.toMatchObject({ delivery: "ambiguous" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("preserves ambiguity if a rejected disposition cannot be recorded", async () => {
    const { receipts, handler, command, dispatch } = fixture();
    dispatch.mockRejectedValueOnce(new RuntimeRequestError("Provider unavailable"));
    vi.spyOn(receipts, "fail").mockImplementation(() => { throw new Error("read-only database"); });
    await expect(handler({} as never, command)).rejects.toMatchObject({ delivery: "ambiguous" });
    await expect(handler({} as never, command)).rejects.toMatchObject({ delivery: "ambiguous" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps corrupt accepted receipts and database read failures ambiguous", async () => {
    const { database, receipts, handler, command, dispatch } = fixture();
    await handler({} as never, command);
    database.prepare("UPDATE message_send_receipts SET response_json = ?").run("invalid-json");
    await expect(handler({} as never, command)).rejects.toMatchObject({ delivery: "ambiguous" });
    database.prepare("UPDATE message_send_receipts SET response_json = ?").run('{"type":"invalid"}');
    await expect(handler({} as never, command)).rejects.toMatchObject({ delivery: "ambiguous" });
    vi.spyOn(receipts, "begin").mockImplementation(() => { throw new Error("SQLITE_IOERR"); });
    await expect(handler({} as never, command)).rejects.toMatchObject({ delivery: "ambiguous" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
