import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProviderInfo } from "../../src/shared/contracts";
import { RuntimeStore } from "../../src/server/database";
import type {
  ProviderRunCallbacks,
  ProviderRunInput,
  ProviderRunResult,
} from "../../src/server/provider/contracts";
import { PrivateGeneratedAttachmentStore } from "../../src/server/runtime/attachments/private-generated-attachments";
import { TurnController } from "../../src/server/runtime/turns/turn-controller";
import type { TurnProviderRuntime } from "../../src/server/runtime/turns/turn-controller-types";
import { resolveNativeModelRoute } from "./model-route-fixture";

const directories: string[] = [];

function providerInfo(): ProviderInfo {
  const metadata = {
    freshness: "fresh" as const,
    provenance: "provider" as const,
    updatedAt: "2030-01-01T00:00:00.000Z",
    lastAttemptedAt: "2030-01-01T00:00:00.000Z",
    refreshing: false,
  };
  return {
    id: "codex",
    label: "Codex",
    command: "codex",
    available: true,
    version: "test",
    executable: "codex",
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: null,
    models: [{
      id: "gpt-test",
      label: "GPT Test",
      description: "",
      isDefault: true,
      inputModalities: ["text", "image"],
      reasoningOptions: [],
      defaultReasoningEffort: "",
    }],
    rateLimits: [],
    metadataState: { models: metadata, rateLimits: metadata },
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("generated turn attachment lifecycle", () => {
  it("releases pages after exact natural, cancellation, and pre-start cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-generated-turn-"));
    directories.push(directory);
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const generated = await PrivateGeneratedAttachmentStore.create(directory);
    const store = new RuntimeStore(join(directory, "runtime.sqlite"), workspace, {
      recoverInterruptedRuns: false,
    });
    const project = store.createProject("Generated pages", workspace);
    const conversation = store.createConversation(project.id, "Scanned PDF", {
      providerId: "codex",
      model: "gpt-test",
    });
    let input: ProviderRunInput | null = null;
    let resolveRun: ((result: ProviderRunResult) => void) | null = null;
    let resolveStop!: () => void;
    let stopGate = new Promise<"settled">((resolve) => {
      resolveStop = () => resolve("settled");
    });
    const providers = {
      resolveModelRoute: resolveNativeModelRoute,
      harnessIdFor: (runInput: ProviderRunInput) => runInput.harnessId,
      run: (runInput: ProviderRunInput, callbacks: ProviderRunCallbacks) => {
        input = runInput;
        callbacks.onStarted?.();
        return new Promise<ProviderRunResult>((resolve) => { resolveRun = resolve; });
      },
      cancel: () => true,
      stopOwned: () => stopGate,
      isRunning: () => resolveRun !== null,
    } as unknown as TurnProviderRuntime;
    let observeFirstGeneratedRelease!: (release: Promise<void>) => void;
    const firstGeneratedRelease = new Promise<void>((resolve, reject) => {
      observeFirstGeneratedRelease = (release) => {
        void release.then(resolve, reject);
      };
    });
    let sequence = 0;
    const controller = new TurnController(
      store,
      providers,
      new Map(),
      new Map(),
      new Map(),
      {
        broadcast: () => undefined,
        broadcastSnapshot: () => undefined,
        providerInfo: () => [providerInfo()],
        releaseGeneratedAttachments: (paths) => {
          const release = generated.release(paths);
          observeFirstGeneratedRelease(release);
          return release;
        },
      },
      { id: () => `generated-turn-${++sequence}` },
    );
    const settleProvider = (status: ProviderRunResult["status"]): void => {
      const current = input!;
      resolveRun!({
        providerId: current.providerId,
        conversationId: current.conversationId ?? current.threadId,
        status,
        text: "",
        textTruncated: false,
        exitCode: 0,
        signal: null,
        cleanupConfirmed: true,
      });
      resolveRun = null;
    };

    const cancelledPage = await generated.writeJpeg(new Uint8Array([1]));
    const cancelled = controller.queue({
      conversationId: conversation.id,
      content: "Cancel this scan.",
      imagePaths: [cancelledPage],
      generatedAttachmentPaths: [cancelledPage],
    });
    controller.start(cancelled.turn.id);
    expect(controller.cancel(conversation.id)).toBe(true);
    settleProvider("cancelled");
    await firstGeneratedRelease;
    await expect(access(cancelledPage)).rejects.toThrow();
    resolveStop();
    await controller.waitForProviderCleanup([conversation.id]);
    await expect(access(cancelledPage)).rejects.toThrow();

    const prestartPage = await generated.writeJpeg(new Uint8Array([2]));
    const prestart = controller.queue({
      conversationId: conversation.id,
      content: "Fail before start.",
      imagePaths: [prestartPage],
      generatedAttachmentPaths: [prestartPage],
    });
    expect(controller.failBeforeStart(conversation.id, "Injected failure"))
      .toBe(true);
    await controller.drainSettlementTasks();
    await expect(access(prestartPage)).rejects.toThrow();
    expect(store.agentTurn(prestart.turn.id).status).toBe("failed");

    stopGate = Promise.resolve("settled");
    const completedPage = await generated.writeJpeg(new Uint8Array([3]));
    const completed = controller.queue({
      conversationId: conversation.id,
      content: "Complete this scan.",
      imagePaths: [completedPage],
      generatedAttachmentPaths: [completedPage],
    });
    controller.start(completed.turn.id);
    settleProvider("completed");
    await flush();
    await controller.drainSettlementTasks();
    await expect(access(completedPage)).rejects.toThrow();
    expect(store.agentTurn(completed.turn.id).status).toBe("completed");
    store.close();
  });
});
