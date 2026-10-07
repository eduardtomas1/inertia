import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseRuntimeWorkerCommand, parseRuntimeWorkerEvent } from "../../src/node/runtime-process-protocol";
import { RuntimeStore } from "../../src/server/database";
import { answerRuntimeHtmlRenderRead } from "../../src/server/runtime-html-render-reads";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

const REQUEST_ID = "0b5e3a52-1c55-4a0e-9d6f-1f8f3e7a2c10";
const RENDER_ID = "6f9619ff-8b86-4d01-b42d-00c04fc964ff";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function command(renderId = RENDER_ID) {
  const parsed = parseRuntimeWorkerCommand({ type: "runtime.read-html-render", requestId: REQUEST_ID, renderId });
  if (parsed?.type !== "runtime.read-html-render") throw new Error("Expected a render read command.");
  return parsed;
}

describe("runtime html render reads", () => {
  it("resolves a stored page from the runtime store in a form main accepts", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-render-read-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const store = new RuntimeStore(join(root, "inertia.sqlite"), workspace, { recoverInterruptedRuns: false });
    try {
      const project = store.createProject("Reads", workspace);
      const conversation = store.createConversation(project.id, "Reads", {
        modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" }),
      });
      const turn = store.beginAgentTurn({
        conversationId: conversation.id,
        runId: "run-read",
        content: "Render it.",
        providerId: "codex",
        modelSelection: conversation.modelSelection,
        reasoningEffort: "",
        interactionMode: "build",
        accessMode: "supervised",
        configurationRevision: conversation.modelSelection.backendConfigurationRevision,
        association: "authoritative",
      }).turn;
      const { renderId } = store.htmlRenders.create({
        conversationId: conversation.id, runId: turn.runId, turnId: turn.id, title: "Table", html: "<table></table>", height: 360,
      });
      const reader = { readHtmlRender: (id: string) => store.htmlRenders.read(id) };
      const event = answerRuntimeHtmlRenderRead(reader, command(renderId));
      expect(event).toEqual({
        type: "runtime.html-render-resolved",
        requestId: REQUEST_ID,
        render: { conversationId: conversation.id, title: "Table", html: "<table></table>" },
      });
      expect(parseRuntimeWorkerEvent(event)).toEqual(event);

      const missing = answerRuntimeHtmlRenderRead(reader, command());
      expect(missing).toEqual({ type: "runtime.html-render-resolved", requestId: REQUEST_ID, render: null });
      expect(parseRuntimeWorkerEvent(missing)).toEqual(missing);
    } finally {
      store.close();
    }
  });

  it("rejects when the runtime is unavailable or the read fails, without leaking detail", () => {
    const unavailable = answerRuntimeHtmlRenderRead(null, command());
    expect(unavailable).toEqual({
      type: "runtime.html-render-rejected", requestId: REQUEST_ID, message: "The local runtime is not ready.",
    });
    expect(parseRuntimeWorkerEvent(unavailable)).toEqual(unavailable);

    const failed = answerRuntimeHtmlRenderRead({
      readHtmlRender: () => { throw new Error("SQLITE_CORRUPT at /secret/inertia.sqlite"); },
    }, command());
    expect(failed).toEqual({
      type: "runtime.html-render-rejected", requestId: REQUEST_ID, message: "The rendered page could not be read.",
    });
    expect(parseRuntimeWorkerEvent(failed)).toEqual(failed);
  });

  it("only receives well-formed read commands", () => {
    expect(parseRuntimeWorkerCommand({ type: "runtime.read-html-render", requestId: REQUEST_ID, renderId: "../x" })).toBeNull();
    expect(parseRuntimeWorkerCommand({ type: "runtime.read-html-render", requestId: "x", renderId: RENDER_ID })).toBeNull();
    expect(parseRuntimeWorkerCommand({
      type: "runtime.read-html-render", requestId: REQUEST_ID, renderId: RENDER_ID, extra: true,
    })).toBeNull();
  });
});
