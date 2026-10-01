import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

import { metadataFor } from "../../src/node/conversation-attachment-store-metadata";
import type { ChatAttachmentMimeType } from "../../src/shared/attachments";

// The secure filesystem operation is covered by conversation-attachment-store
// tests. Supply its receipt here to exercise the real worker's validation and
// result/ack boundary without changing the test runner's working directory.
vi.mock("../../src/node/conversation-attachment-store-child.js", () => ({
  CONVERSATION_ATTACHMENT_STORE_OPERATION_SOURCE: `
    async function performConversationAttachmentStoreOperation(operation) {
      return operation.receipt;
    }
  `,
}));

const attachmentId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAANSURBVAiZY2BgYPgPAAEEAQB9ssjfAAAAAElFTkSuQmCC",
  "base64",
);
const originalParentPort = Object.getOwnPropertyDescriptor(process, "parentPort");

function receiptFor(
  bytes: Buffer,
  name = "reference.png",
  mimeType: ChatAttachmentMimeType = "image/png",
) {
  return {
    missing: false,
    metadata: JSON.stringify(metadataFor({
      attachment: {
        id: attachmentId,
        name,
        mimeType,
        size: bytes.length,
        path: "/unused",
      },
      bytes,
    })),
    bytesBase64: bytes.toString("base64"),
  };
}

async function perform(receipt?: unknown) {
  const parentPort = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  Object.defineProperty(process, "parentPort", {
    configurable: true,
    value: parentPort,
  });
  await import("../../src/main/conversation-attachment-store-worker");
  parentPort.emit("message", { data: {
    type: "conversation-attachment-store.perform",
    operationId,
    encodedOperation: JSON.stringify({ receipt }),
  } });
  await vi.waitFor(() => expect(parentPort.postMessage).toHaveBeenCalledOnce());
  return parentPort;
}

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalParentPort) {
    Object.defineProperty(process, "parentPort", originalParentPort);
  } else {
    Reflect.deleteProperty(process, "parentPort");
  }
});

describe("retained attachment utility validation", () => {
  it("validates a retained image before reporting success and waits for acknowledgement", async () => {
    const receipt = receiptFor(png);
    const parentPort = await perform(receipt);
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      type: "conversation-attachment-store.result",
      operationId,
      ok: true,
      receipt,
    });
    expect(process.exit).not.toHaveBeenCalled();
    parentPort.emit("message", { data: {
      type: "conversation-attachment-store.result-ack",
      operationId,
    } });
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("validates spreadsheet archives in the utility result path", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["retained", 1]]));
    const receipt = receiptFor(
      XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer,
      "reference.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    const parentPort = await perform(receipt);
    expect(parentPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      receipt,
    }));
  });

  it.each([
    ["reference.png", "image/png", png.subarray(0, 33)],
    ["reference.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", Buffer.from("PK\x03\x04invalid")],
  ] as const)("rejects malformed %s even when its persisted digest matches", async (name, mimeType, bytes) => {
    const parentPort = await perform(receiptFor(bytes, name, mimeType));
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      type: "conversation-attachment-store.result",
      operationId,
      ok: false,
    });
    expect(process.exit).not.toHaveBeenCalled();
    parentPort.emit("message", { data: {
      type: "conversation-attachment-store.result-ack",
      operationId,
    } });
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it.each([
    { digest: "0".repeat(64) },
    { size: png.length + 1 },
  ])("rejects inconsistent retained metadata %j", async (patch) => {
    const receipt = receiptFor(png);
    receipt.metadata = JSON.stringify({ ...JSON.parse(receipt.metadata), ...patch });
    const parentPort = await perform(receipt);
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      type: "conversation-attachment-store.result",
      operationId,
      ok: false,
    });
  });

  it.each([
    { version: 2 },
    { mimeType: "application/pdf" },
    { extension: "pdf" },
    { digest: "invalid" },
  ])("treats invalid metadata as missing so retention can repair it (%j)", async (patch) => {
    const receipt = receiptFor(png);
    receipt.metadata = JSON.stringify({ ...JSON.parse(receipt.metadata), ...patch });
    const parentPort = await perform(receipt);
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      type: "conversation-attachment-store.result",
      operationId,
      ok: true,
      receipt: { missing: true },
    });
  });

  it.each([undefined, { missing: true }])("preserves non-content receipts (%j)", async (receipt) => {
    const loadParser = vi.fn(async () =>
      await vi.importActual("../../src/main/attachment-import.js"));
    vi.doMock("../../src/main/attachment-import.js", loadParser);
    try {
      const parentPort = await perform(receipt);
      expect(parentPort.postMessage).toHaveBeenCalledWith({
        type: "conversation-attachment-store.result",
        operationId,
        ok: true,
        ...(receipt === undefined ? {} : { receipt }),
      });
      expect(loadParser).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../../src/main/attachment-import.js");
    }
  });
});
