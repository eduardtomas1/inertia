import { mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PrivateConnectRuntimeGateway } from "../../../src/server/private-connect/runtime-gateway";
import { RuntimeStore } from "../../../src/server/database";
import { privateConnectRuntimeGrantsFromProjectIds } from "../../../src/shared/private-connect/runtime-grants";
import type { PrivateConnectRuntimeAuthorization } from "../../../src/shared/private-connect/runtime-contract";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("Private Connect supervised runtime gateway", () => {
  it("projects only granted conversations and never queues an ungranted prompt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-private-connect-runtime-"));
    directories.push(directory);
    const store = new RuntimeStore(join(directory, "inertia.sqlite"), directory);
    const project = store.createProject("Allowed", directory);
    const conversation = store.createConversation(project.id, "Allowed chat");
    const secretProject = store.createProject("Hidden", directory);
    const hiddenConversation = store.createConversation(secretProject.id, "Hidden chat");
    let queued = 0;
    const gateway = new PrivateConnectRuntimeGateway({
      shell: () => store.shellSnapshot(),
      detail: (conversationId) => store.conversationDetail(conversationId),
      isConversationActive: () => false,
      preparePrompt: async () => undefined,
      queuePrompt: () => ({ turnId: `turn-${++queued}` }),
    });
    const subject: PrivateConnectRuntimeAuthorization = {
      deviceId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      scopes: ["view", "prompt"],
      projectIds: [project.id],
      grants: privateConnectRuntimeGrantsFromProjectIds([project.id]),
      grantVersion: 1,
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    const state = await gateway.request(subject, { type: "state.get", requestId: "33333333-3333-4333-8333-333333333333" });
    expect(state.ok).toBe(true);
    if (state.ok && state.result.kind === "state") expect(state.result.state.conversations.map(({ id }) => id)).toContain(conversation.id);
    const hidden = await gateway.request(subject, { type: "conversation.get", requestId: "44444444-4444-4444-8444-444444444444", conversationId: hiddenConversation.id });
    expect(hidden).toMatchObject({ ok: false, code: "not-found" });
    const prompt = await gateway.request(subject, { type: "prompt.send", requestId: "55555555-5555-4555-8555-555555555555", deliveryId: "66666666-6666-4666-8666-666666666666", conversationId: hiddenConversation.id, content: "do not send" });
    expect(prompt.ok).toBe(false);
    expect(queued).toBe(0);
  });
});
