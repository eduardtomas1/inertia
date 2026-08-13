import { describe, expect, it } from "vitest";

import { parseAttachmentHandoffRequest } from "../../src/shared/attachment-handoff";

const requestId = "11111111-1111-4111-8111-111111111111";
const attachmentId = "22222222-2222-4222-8222-222222222222";

describe("attachment handoff IPC payload", () => {
  it("accepts only one strict request with unique opaque capabilities", () => {
    expect(parseAttachmentHandoffRequest({
      requestId,
      attachmentIds: [attachmentId],
    })).toEqual({ requestId, attachmentIds: [attachmentId] });
    expect(parseAttachmentHandoffRequest({
      requestId,
      attachmentIds: [attachmentId, attachmentId],
    })).toBeNull();
    expect(parseAttachmentHandoffRequest({
      requestId,
      attachmentIds: [attachmentId],
      extra: true,
    })).toBeNull();
    expect(parseAttachmentHandoffRequest({
      requestId: "not-a-request",
      attachmentIds: [attachmentId],
    })).toBeNull();
  });
});
