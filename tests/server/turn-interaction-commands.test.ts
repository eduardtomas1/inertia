import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, type Mock, vi } from "vitest";

import type {
  ChatAttachment,
  ChatMessage,
  ClientCommand,
  ProviderSkillInput,
  ProviderInfo,
} from "../../src/shared/contracts";
import {
  PDF_MODULE_INITIALIZATION_TIMEOUT_MS,
} from "../../src/server/runtime/attachments/document-attachment-context";
import { PrivateGeneratedAttachmentStore } from "../../src/server/runtime/attachments/private-generated-attachments";
import { RuntimeRequestError } from "../../src/server/runtime-errors";
import {
  createTurnInteractionCommandHandler,
  type TurnInteractionCommandDependencies,
} from "../../src/server/runtime/commands/turn-interaction-commands";
import type { TurnAdmissionLease } from "../../src/server/runtime/turns/turn-controller-types";
import { MESSAGE_SEND_PREPARATION_TIMEOUT_MS } from "../../src/shared/runtime-command-timeouts";

const conversationId = "11111111-1111-4111-8111-111111111111";
const execFileAsync = promisify(execFile);
const requestAttachment: ChatAttachment = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "request.png",
  path: "opaque-renderer-path",
  mimeType: "image/png",
  size: 8,
};
const trustedAttachment: ChatAttachment = {
  ...requestAttachment,
  path: "/private/runtime/request.png",
};

function queuedTurn(
  turnId = "44444444-4444-4444-8444-444444444444",
) {
  return {
    turn: { id: turnId, conversationId },
    message: {
      id: "99999999-9999-4999-8999-999999999999",
      conversationId,
      turnId,
    },
  };
}

function messageCommand(
  activate?: boolean,
): Extract<ClientCommand, { type: "message.send" }> {
  return {
    type: "message.send",
    requestId: "33333333-3333-4333-8333-333333333333",
    payload: {
      conversationId,
      content: "Use the selected attachment.",
      attachments: [requestAttachment],
      ...(activate === undefined ? {} : { activate }),
    },
  };
}

function blankPdf(): Uint8Array {
  const stream = "BT /F1 22 Tf 72 720 Td (Page 1 of 1) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) =>
    `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

function providerWithImages(supportsImages: boolean): ProviderInfo {
  return {
    id: "codex",
    canRun: true,
    statusMessage: null,
    models: [{
      id: "gpt-test",
      isDefault: true,
      inputModalities: supportsImages ? ["text", "image"] : ["text"],
    }],
  } as unknown as ProviderInfo;
}

function externalSelection(
  imageState: "verified" | "unknown",
) {
  return {
    harnessId: "codex-app-server" as const,
    backendProfileId: "custom:test",
    backendProfileDisplayName: "Custom test",
    modelId: "gpt-test",
    alias: null,
    reasoningEffort: null,
    contextWindowOverride: null,
    providerOptions: {},
    capabilities: [{
      id: "images" as const,
      state: imageState,
      provenance: imageState === "verified" ? "probe" as const : "unknown" as const,
      detail: null,
    }],
    backendConfigurationRevision: 1,
  };
}

function dependencies(options: {
  queue: ReturnType<typeof vi.fn>;
  relinquishAll: ReturnType<typeof vi.fn>;
  readiness?: ReturnType<typeof vi.fn>;
  resolveSkills?: Mock<(
    conversationId: string,
    content: string,
  ) => Promise<ProviderSkillInput[]>>;
  assertTurnSkillsCurrent?: Mock<(
    conversationId: string,
    routeKey: string | null,
  ) => void>;
  conversationPath?: string;
  checkpointCount?: Mock<() => number>;
  providerTerminalResumeActive?: boolean;
  providerTerminalResumeAcquire?: boolean;
  providerTerminalResumeAcquireWhenAvailable?: Mock<(
    conversationId: string,
    timeoutMs?: number,
  ) => Promise<boolean>>;
  enableProviders?: boolean;
  generatedAttachments?: PrivateGeneratedAttachmentStore;
  provider?: ProviderInfo;
  resolvedPayloads?: Array<{
    attachment: ChatAttachment;
    bytes: Uint8Array;
  }>;
  validatedSelection?: ReturnType<
    TurnInteractionCommandDependencies["backendProfileController"]["validateSelection"]
  >;
  externalSelection?: boolean;
  turnAdmissionRelease?: ReturnType<typeof vi.fn>;
  providerId?: ProviderInfo["id"];
}): TurnInteractionCommandDependencies {
  const providerId = options.providerId ?? "codex";
  const provider = options.provider ?? {
    id: providerId,
    canRun: true,
    statusMessage: null,
    models: [],
  } as unknown as ProviderInfo;
  return {
    store: {
      conversation: vi.fn(() => ({
        id: conversationId,
        title: "Existing conversation",
        providerId,
        model: null,
        reasoningEffort: "",
        modelSelection: {
          providerId: "codex",
          harnessId: "codex-app-server",
          backendProfileId: "builtin:openai",
          modelId: "gpt-test",
          alias: null,
          reasoningEffort: null,
          contextWindowOverride: null,
          providerOptions: {},
          capabilities: [],
          backendConfigurationRevision: 0,
        },
      })),
      conversationPath: vi.fn(() => options.conversationPath ?? tmpdir()),
      checkpointCount: options.checkpointCount ?? vi.fn(() => 0),
      addCheckpoint: vi.fn(() => ({
        id: "55555555-5555-4555-8555-555555555555",
      })),
      removeUnassociatedCheckpoint: vi.fn(() => true),
      createMessage: vi.fn(() => ({ id: "message-id" })),
      updateConversation: vi.fn(),
    } as unknown as TurnInteractionCommandDependencies["store"],
    conversationAttachments: {
      retain: vi.fn(async (payloads: Array<{
        attachment: ChatAttachment;
      }>) => payloads.map(({ attachment }) => attachment)),
      release: vi.fn(async () => undefined),
      acceptRetention: vi.fn(),
      releaseRetention: vi.fn(async () => undefined),
    } as unknown as TurnInteractionCommandDependencies["conversationAttachments"],
    backendProfileController: {
      validateSelection: vi.fn((selection) =>
        options.validatedSelection ?? selection),
      isExternalSelection: vi.fn(() => options.externalSelection ?? false),
      readiness: options.readiness ?? vi.fn(async () => null),
    } as unknown as TurnInteractionCommandDependencies["backendProfileController"],
    turns: {
      isActive: vi.fn(() => false),
      acquireTurnAdmission: vi.fn(async () => ({
        conversationId,
        token: Symbol("test-turn-admission"),
        release: options.turnAdmissionRelease ?? vi.fn(),
      })),
      acquireFollowUpAdmission: vi.fn(() => ({
        conversationId,
        runId: "66666666-6666-4666-8666-666666666666",
        turnId: "88888888-8888-4888-8888-888888888888",
        supportsImages: true,
        submittedAt: "2026-07-30T06:00:00.000Z",
        ready: Promise.resolve(),
        release: vi.fn(),
      })),
      steer: vi.fn(async () => null),
      queue: options.queue,
      start: vi.fn(() => true),
      failBeforeStart: vi.fn(() => true),
    } as unknown as TurnInteractionCommandDependencies["turns"],
    isolatedRuns: {
      has: vi.fn(() => false),
    } as unknown as TurnInteractionCommandDependencies["isolatedRuns"],
    workspaceRuns: {} as TurnInteractionCommandDependencies["workspaceRuns"],
    pendingApprovals: new Map(),
    pendingInputs: new Map(),
    dataDirectory: tmpdir(),
    enableProviders: options.enableProviders ?? true,
    attachmentResolver: {
      resolvePayloads: vi.fn(async () => options.resolvedPayloads ?? [{
        attachment: trustedAttachment,
        bytes: new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]),
      }]),
      relinquishAll: options.relinquishAll,
      releaseAll: vi.fn(async () => undefined),
    } as unknown as TurnInteractionCommandDependencies["attachmentResolver"],
    generatedAttachments: options.generatedAttachments ?? {
      release: vi.fn(async () => undefined),
    } as unknown as TurnInteractionCommandDependencies["generatedAttachments"],
    workflows: {
      resolveTurnSkills: vi.fn(async (
        selectedConversationId: string,
        content: string,
      ) => {
        const inputs = await (
          options.resolveSkills ?? vi.fn(() => [])
        )(selectedConversationId, content);
        return {
          inputs,
          routeKey: inputs.length > 0 ? "test-route" : null,
        };
      }),
      assertTurnSkillsCurrent:
        options.assertTurnSkillsCurrent ?? vi.fn(),
    } as unknown as TurnInteractionCommandDependencies["workflows"],
    providerTerminalResumes: {
      isActive: vi.fn(() => options.providerTerminalResumeActive ?? false),
      acquire: vi.fn(() => options.providerTerminalResumeAcquire
        ?? !(options.providerTerminalResumeActive ?? false)),
      acquireWhenAvailable:
        options.providerTerminalResumeAcquireWhenAvailable
          ?? vi.fn(async () => options.providerTerminalResumeAcquire
            ?? !(options.providerTerminalResumeActive ?? false)),
      release: vi.fn(),
    } as unknown as TurnInteractionCommandDependencies["providerTerminalResumes"],
    providerInfo: () => [provider],
    broadcast: vi.fn(),
    broadcastSnapshot: vi.fn(),
    send: vi.fn(),
  };
}

describe("turn stop cleanup", () => {
  it("does not acknowledge Stop until provider cleanup is confirmed", async () => {
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = dependencies({
      queue: vi.fn(),
      relinquishAll: vi.fn(async () => undefined),
    });
    const cancel = vi.fn(() => true);
    const waitForProviderCleanup = vi.fn(async () => await cleanup);
    Object.assign(runtime.turns, { cancel, waitForProviderCleanup });
    vi.mocked(runtime.turns.isActive).mockReturnValue(false);
    Object.assign(runtime.isolatedRuns, {
      stopConversation: vi.fn(() => false),
    });
    const handler = createTurnInteractionCommandHandler(runtime);
    let settled = false;
    const result = handler({} as never, {
      type: "agent.stop",
      requestId: "33333333-3333-4333-8333-333333333333",
      payload: { conversationId },
    }).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(waitForProviderCleanup).toHaveBeenCalledWith([
      conversationId,
    ]));
    expect(settled).toBe(false);

    release();
    await expect(result).resolves.toBe("mutation");
    expect(cancel).toHaveBeenCalledWith(conversationId);
  });

  it("reports that Resume remains unavailable when cleanup is unconfirmed", async () => {
    const runtime = dependencies({
      queue: vi.fn(),
      relinquishAll: vi.fn(async () => undefined),
    });
    Object.assign(runtime.turns, {
      cancel: vi.fn(() => true),
      waitForProviderCleanup: vi.fn(async () => undefined),
    });
    vi.mocked(runtime.turns.isActive).mockReturnValue(true);
    Object.assign(runtime.isolatedRuns, {
      stopConversation: vi.fn(() => false),
    });
    const handler = createTurnInteractionCommandHandler(runtime);

    await expect(handler({} as never, {
      type: "agent.stop",
      requestId: "33333333-3333-4333-8333-333333333333",
      payload: { conversationId },
    })).rejects.toThrow(
      "provider cleanup could not be confirmed. Resume remains unavailable",
    );
  });
});

describe("new-turn admission recovery", () => {
  it.each([
    { stage: "conversation-state", failure: "conversation" },
    { stage: "active-route", failure: "active-route" },
  ] as const)(
    "classifies an unexpected $failure preflight failure",
    async ({ stage, failure }) => {
      const runtime = dependencies({
        queue: vi.fn(),
        relinquishAll: vi.fn(async () => undefined),
      });
      if (failure === "conversation") {
        vi.mocked(runtime.store.conversation).mockImplementationOnce(() => {
          throw new Error("injected conversation read failure");
        });
      } else {
        vi.mocked(runtime.turns.isActive).mockImplementationOnce(() => {
          throw Object.assign(new Error("injected ownership read failure"), {
            code: "sk-sensitivecredentialvalue",
          });
        });
      }

      const error = await createTurnInteractionCommandHandler(runtime)(
        {} as never,
        messageCommand(),
      ).then(() => null, (failure: unknown) => failure);
      const code = `message-send/${stage}/unexpected`;
      expect(error).toBeInstanceOf(RuntimeRequestError);
      expect((error as RuntimeRequestError).code).toBe(code);
      expect((error as Error).message).toContain(`[${code}]`);
      expect((error as Error).message).not.toContain(
        "sk-sensitivecredentialvalue",
      );
      expect(runtime.turns.acquireTurnAdmission).not.toHaveBeenCalled();
      expect(runtime.turns.queue).not.toHaveBeenCalled();
    },
  );

  it.each([
    "codex",
    "claude",
    "cursor",
    "kimi",
    "opencode",
  ] as const)("uses the same admission handoff for the %s provider", async (providerId) => {
    const queue = vi.fn(() => queuedTurn());
    const runtime = dependencies({
      queue,
      relinquishAll: vi.fn(async () => undefined),
      providerId,
    });
    const handler = createTurnInteractionCommandHandler(runtime);

    await expect(handler({} as never, messageCommand()))
      .resolves.toBe("handled");
    expect(runtime.turns.acquireTurnAdmission)
      .toHaveBeenCalledWith(conversationId, expect.any(Number));
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId }),
      expect.any(Function),
      expect.objectContaining({ conversationId }),
    );
  });

  it.each([
    { failure: "readiness", stage: "backend-readiness" },
    { failure: "skills", stage: "skills" },
    { failure: "transition", stage: "provider-transition" },
    { failure: "retention", stage: "retention" },
    { failure: "persistence", stage: "turn-persistence" },
  ] as const)(
    "releases admission after $failure failure and accepts an immediate retry",
    async ({ failure, stage }) => {
      const releaseAdmission = vi.fn();
      const queue = vi.fn(() => queuedTurn());
      const readiness = vi.fn(async () => null);
      const resolveSkills = vi.fn(async () => [] as ProviderSkillInput[]);
      const acquireTransition = vi.fn(async () => true);
      const runtime = dependencies({
        queue,
        relinquishAll: vi.fn(async () => undefined),
        readiness,
        resolveSkills,
        providerTerminalResumeAcquireWhenAvailable: acquireTransition,
        turnAdmissionRelease: releaseAdmission,
      });
      if (failure === "readiness") {
        readiness.mockRejectedValueOnce(new Error("injected readiness failure"));
      } else if (failure === "skills") {
        resolveSkills.mockRejectedValueOnce(new Error("injected skills failure"));
      } else if (failure === "transition") {
        acquireTransition.mockResolvedValueOnce(false);
      } else if (failure === "retention") {
        vi.mocked(runtime.conversationAttachments.retain)
          .mockRejectedValueOnce(new Error("injected retention failure"));
      } else {
        queue.mockImplementationOnce(() => {
          throw new Error("injected persistence failure");
        });
      }
      const handler = createTurnInteractionCommandHandler(runtime);

      const firstError = await handler({} as never, messageCommand())
        .then(() => null, (error: unknown) => error);
      expect(firstError).toBeInstanceOf(RuntimeRequestError);
      expect((firstError as Error).message)
        .not.toBe("The request could not be completed.");
      if (failure === "transition") {
        expect((firstError as RuntimeRequestError).code).toBeUndefined();
        expect((firstError as Error).message).toContain(
          "End the resumed provider terminal",
        );
      } else {
        const code = `message-send/${stage}/unexpected`;
        expect((firstError as RuntimeRequestError).code).toBe(code);
        expect((firstError as Error).message).toContain(`[${code}]`);
      }
      expect(releaseAdmission).toHaveBeenCalledTimes(1);

      await expect(handler({} as never, messageCommand()))
        .resolves.toBe("handled");
      expect(releaseAdmission).toHaveBeenCalledTimes(2);
    },
  );

  it("releases an admission lease that arrives after preparation timed out", async () => {
    vi.useFakeTimers();
    try {
      let resolveLateAdmission!: (
        admission: TurnAdmissionLease | null,
      ) => void;
      const lateRelease = vi.fn();
      const retryRelease = vi.fn();
      const runtime = dependencies({
        queue: vi.fn(() => queuedTurn()),
        relinquishAll: vi.fn(async () => undefined),
      });
      vi.mocked(runtime.turns.acquireTurnAdmission)
        .mockReturnValueOnce(new Promise((resolve) => {
          resolveLateAdmission = resolve;
        }))
        .mockResolvedValueOnce({
          conversationId,
          token: Symbol(),
          release: retryRelease,
        });
      const handler = createTurnInteractionCommandHandler(runtime);
      const handling = handler({} as never, messageCommand());
      const rejection = expect(handling).rejects.toThrow(
        "Preparing this message took too long. No turn was started.",
      );

      await vi.advanceTimersByTimeAsync(MESSAGE_SEND_PREPARATION_TIMEOUT_MS);
      await rejection;
      resolveLateAdmission({
        conversationId,
        token: Symbol(),
        release: lateRelease,
      });
      await vi.waitFor(() => expect(lateRelease).toHaveBeenCalledOnce());

      await expect(handler({} as never, messageCommand()))
        .resolves.toBe("handled");
      expect(retryRelease).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts a detached-socket retry after the main socket publication fails", async () => {
    const queue = vi.fn((
      _request: unknown,
      onPersisted: () => void,
    ) => {
      onPersisted();
      if (queue.mock.calls.length === 1) {
        throw new Error("injected main-window publication failure");
      }
      return queuedTurn();
    });
    const runtime = dependencies({
      queue,
      relinquishAll: vi.fn(async () => undefined),
    });
    const handler = createTurnInteractionCommandHandler(runtime);
    const mainSocket = { kind: "main" } as never;
    const detachedSocket = { kind: "detached" } as never;

    await expect(handler(mainSocket, messageCommand())).rejects.toThrow(
      "message-send/turn-publication/unexpected",
    );
    const retry = messageCommand();
    retry.requestId = "77777777-7777-4777-8777-777777777777";
    retry.payload.activate = false;
    await expect(handler(detachedSocket, retry)).resolves.toBe("handled");
    expect(runtime.send).toHaveBeenCalledWith(detachedSocket, {
      type: "request.result",
      requestId: retry.requestId,
      result: expect.objectContaining({
        kind: "message.accepted",
        conversationId,
        disposition: "new-turn",
      }),
    });
  });
});

describe("attachment send handoff", () => {
  it("binds runtime attachment resolution to the message request identity", async () => {
    const runtime = dependencies({
      queue: vi.fn(() => null),
      relinquishAll: vi.fn(async () => undefined),
      enableProviders: false,
    });
    const handler = createTurnInteractionCommandHandler(runtime);
    const command = messageCommand();

    await expect(handler({} as never, command)).resolves.toBe("handled");
    expect(runtime.attachmentResolver?.resolvePayloads).toHaveBeenCalledWith(
      command.payload.attachments,
      command.requestId,
      expect.any(AbortSignal),
    );
  });
});

describe("message attachment ownership transfer", () => {
  it.each([
    { label: "model rejection", queueRejects: false, supportsImages: false },
    { label: "queue rejection", queueRejects: true, supportsImages: true },
  ])("cleans scanned PDF pages after $label", async ({
    queueRejects,
    supportsImages,
  }) => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-command-scan-"));
    try {
      const generatedAttachments = await PrivateGeneratedAttachmentStore.create(
        directory,
      );
      const pdf = {
        ...trustedAttachment,
        name: "Informe-escanejat-amb-accents.pdf",
        path: join(directory, "22222222-2222-4222-8222-222222222222.pdf"),
        mimeType: "application/pdf" as const,
      };
      const bytes = blankPdf();
      const queue = queueRejects
        ? vi.fn(() => { throw new Error("queue rejected"); })
        : vi.fn();
      const handlerDependencies = dependencies({
        queue,
        relinquishAll: vi.fn(async () => undefined),
        generatedAttachments,
        provider: providerWithImages(supportsImages),
        resolvedPayloads: [{ attachment: pdf, bytes }],
      });
      const command = messageCommand();
      command.payload.attachments = [pdf];

      await expect(createTurnInteractionCommandHandler(handlerDependencies)(
        {} as never,
        command,
      )).rejects.toThrow(
        queueRejects
          ? "message-send/turn-persistence/unexpected"
          : "cannot inspect scanned PDF",
      );
      expect(generatedAttachments.usage()).toEqual({ bytes: 0, records: 0 });
      expect(queue).toHaveBeenCalledTimes(queueRejects ? 1 : 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, PDF_MODULE_INITIALIZATION_TIMEOUT_MS + 15_000);

  it("cleans a generated page when aggregate preparation times out after the private write", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), "inertia-command-late-scan-"));
    try {
      const backingStore = await PrivateGeneratedAttachmentStore.create(directory);
      let releaseWrite!: () => void;
      const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
      let notifyWritten!: () => void;
      const written = new Promise<void>((resolve) => { notifyWritten = resolve; });
      const delayedStore = {
        writeJpeg: async (bytes: Uint8Array) => {
          const path = await backingStore.writeJpeg(bytes);
          notifyWritten();
          await writeGate;
          return path;
        },
        release: (paths: readonly string[]) => backingStore.release(paths),
      } as unknown as PrivateGeneratedAttachmentStore;
      const pdf = {
        ...trustedAttachment,
        path: join(directory, "22222222-2222-4222-8222-222222222222.pdf"),
        mimeType: "application/pdf" as const,
      };
      const handlerDependencies = dependencies({
        queue: vi.fn(),
        relinquishAll: vi.fn(async () => undefined),
        generatedAttachments: delayedStore,
        provider: providerWithImages(true),
        resolvedPayloads: [{ attachment: pdf, bytes: blankPdf() }],
      });
      const command = messageCommand();
      command.payload.attachments = [pdf];
      const handling = createTurnInteractionCommandHandler(handlerDependencies)(
        {} as never,
        command,
      );
      const rejection = expect(handling).rejects.toThrow(
        /Document extraction exceeded|Preparing this message took too long/u,
      );
      await written;

      await vi.advanceTimersByTimeAsync(MESSAGE_SEND_PREPARATION_TIMEOUT_MS);
      await rejection;
      expect(backingStore.usage().records).toBe(1);
      releaseWrite();
      await vi.waitFor(() => expect(backingStore.usage()).toEqual({
        bytes: 0,
        records: 0,
      }));
      expect(handlerDependencies.turns.queue).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("cleans scanned pages in transcript-only provider-disabled mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-command-disabled-"));
    try {
      const generatedAttachments = await PrivateGeneratedAttachmentStore.create(
        directory,
      );
      const pdf = {
        ...trustedAttachment,
        path: join(directory, "22222222-2222-4222-8222-222222222222.pdf"),
        mimeType: "application/pdf" as const,
      };
      const handlerDependencies = dependencies({
        queue: vi.fn(),
        relinquishAll: vi.fn(async () => undefined),
        generatedAttachments,
        enableProviders: false,
        resolvedPayloads: [{ attachment: pdf, bytes: blankPdf() }],
      });
      const command = messageCommand();
      command.payload.attachments = [pdf];

      await expect(createTurnInteractionCommandHandler(handlerDependencies)(
        {} as never,
        command,
      )).resolves.toBe("handled");
      expect(generatedAttachments.usage()).toEqual({ bytes: 0, records: 0 });
      expect(handlerDependencies.store.createMessage).toHaveBeenCalledOnce();
      expect(handlerDependencies.conversationAttachments.acceptRetention)
        .toHaveBeenCalledOnce();
      expect(handlerDependencies.attachmentResolver?.releaseAll)
        .toHaveBeenCalledWith([pdf.id]);
      expect(handlerDependencies.conversationAttachments.releaseRetention)
        .not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it.each([
    { state: "verified" as const, accepted: true },
    { state: "unknown" as const, accepted: false },
  ])("uses normalized external image capability '$state' instead of a colliding native catalog model", async ({
    state,
    accepted,
  }) => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-command-external-"));
    try {
      const generatedAttachments = await PrivateGeneratedAttachmentStore.create(
        directory,
      );
      const pdf = {
        ...trustedAttachment,
        path: join(directory, "22222222-2222-4222-8222-222222222222.pdf"),
        mimeType: "application/pdf" as const,
      };
      let queuedGenerated: readonly string[] = [];
      const queue = vi.fn((request) => {
        queuedGenerated = request.generatedAttachmentPaths;
        return queuedTurn();
      });
      const handlerDependencies = dependencies({
        queue,
        relinquishAll: vi.fn(async () => undefined),
        generatedAttachments,
        provider: providerWithImages(false),
        resolvedPayloads: [{ attachment: pdf, bytes: blankPdf() }],
        validatedSelection: externalSelection(state),
        externalSelection: true,
      });
      const command = messageCommand();
      command.payload.attachments = [pdf];
      const handling = createTurnInteractionCommandHandler(handlerDependencies)(
        {} as never,
        command,
      );

      if (accepted) {
        await expect(handling).resolves.toBe("handled");
        expect(queue).toHaveBeenCalledOnce();
        await generatedAttachments.release(queuedGenerated);
      } else {
        await expect(handling).rejects.toThrow(
          "cannot inspect scanned PDF page images",
        );
        expect(queue).not.toHaveBeenCalled();
      }
      expect(generatedAttachments.usage()).toEqual({ bytes: 0, records: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("surfaces a judge reservation rejected by the shared turn queue", async () => {
    const queue = vi.fn(() => {
      throw new Error(
        "This judge chat is reserved for its locked Duo comparison.",
      );
    });
    const handlerDependencies = dependencies({
      queue,
      relinquishAll: vi.fn(async () => undefined),
    });

    await expect(createTurnInteractionCommandHandler(handlerDependencies)(
      {} as never,
      messageCommand(),
    )).rejects.toThrow("message-send/turn-persistence/unexpected");
    expect(queue).toHaveBeenCalledOnce();
  });

  it("does not start a concurrent app turn while the chat is resumed in a terminal", async () => {
    const queue = vi.fn();
    const handlerDependencies = dependencies({
      queue,
      relinquishAll: vi.fn(async () => undefined),
      providerTerminalResumeActive: true,
    });
    const handler = createTurnInteractionCommandHandler(handlerDependencies);

    await expect(handler({} as never, messageCommand())).rejects.toThrow(
      "End the resumed provider terminal",
    );
    expect(queue).not.toHaveBeenCalled();
    expect(
      handlerDependencies.attachmentResolver!.resolvePayloads,
    ).not.toHaveBeenCalled();
  });

  it("rechecks the terminal reservation after asynchronous turn preparation", async () => {
    const queue = vi.fn();
    const relinquishAll = vi.fn(async () => undefined);
    const handlerDependencies = dependencies({
      queue,
      relinquishAll,
      providerTerminalResumeActive: false,
      providerTerminalResumeAcquire: false,
    });
    const handler = createTurnInteractionCommandHandler(handlerDependencies);

    await expect(handler({} as never, messageCommand())).rejects.toThrow(
      "End the resumed provider terminal",
    );
    expect(queue).not.toHaveBeenCalled();
    expect(
      handlerDependencies.providerTerminalResumes.acquireWhenAvailable,
    ).toHaveBeenCalledWith(conversationId, expect.any(Number));
    expect(handlerDependencies.store.conversationPath).not.toHaveBeenCalled();
    expect(handlerDependencies.store.addCheckpoint).not.toHaveBeenCalled();
    expect(relinquishAll).toHaveBeenCalledWith([trustedAttachment.id]);
  });

  it("waits for a transient workflow reservation before starting the turn", async () => {
    let settleReservation!: (acquired: boolean) => void;
    const acquireWhenAvailable = vi.fn(() => new Promise<boolean>((resolve) => {
      settleReservation = resolve;
    }));
    const queue = vi.fn(() => queuedTurn());
    const handlerDependencies = dependencies({
      queue,
      relinquishAll: vi.fn(async () => undefined),
      providerTerminalResumeAcquireWhenAvailable: acquireWhenAvailable,
    });
    const handling = createTurnInteractionCommandHandler(handlerDependencies)(
      {} as never,
      messageCommand(),
    );

    await vi.waitFor(() => expect(acquireWhenAvailable).toHaveBeenCalledWith(
      conversationId,
      expect.any(Number),
    ));
    expect(queue).not.toHaveBeenCalled();

    settleReservation(true);
    await expect(handling).resolves.toBe("handled");
    expect(queue).toHaveBeenCalledOnce();
  });

  it("releases authority acquired after message preparation times out", async () => {
    vi.useFakeTimers();
    try {
      let settleReservation!: (acquired: boolean) => void;
      const acquireWhenAvailable = vi.fn(() =>
        new Promise<boolean>((resolve) => { settleReservation = resolve; }));
      const handlerDependencies = dependencies({
        queue: vi.fn(),
        relinquishAll: vi.fn(async () => undefined),
        providerTerminalResumeAcquireWhenAvailable: acquireWhenAvailable,
      });
      const handling = createTurnInteractionCommandHandler(
        handlerDependencies,
      )({} as never, messageCommand());
      const rejection = expect(handling).rejects.toThrow(
        "Preparing this message took too long. No turn was started.",
      );

      await vi.waitFor(() => expect(acquireWhenAvailable).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(MESSAGE_SEND_PREPARATION_TIMEOUT_MS);
      await rejection;
      expect(handlerDependencies.providerTerminalResumes.release)
        .not.toHaveBeenCalled();

      settleReservation(true);
      await vi.waitFor(() => {
        expect(handlerDependencies.providerTerminalResumes.release)
          .toHaveBeenCalledWith(conversationId);
      });
      expect(handlerDependencies.turns.queue).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts attachment resolution at the aggregate deadline", async () => {
    vi.useFakeTimers();
    try {
      const handlerDependencies = dependencies({
        queue: vi.fn(),
        relinquishAll: vi.fn(async () => undefined),
      });
      const abortObserved = vi.fn();
      vi.mocked(
        handlerDependencies.attachmentResolver!.resolvePayloads,
      ).mockImplementation((_requested, _handoffId, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            abortObserved();
            reject(new Error("Attachment resolution was aborted."));
          }, { once: true });
        }));
      const handling = createTurnInteractionCommandHandler(
        handlerDependencies,
      )({} as never, messageCommand());
      const rejection = expect(handling).rejects.toThrow(
        "Preparing this message took too long. No turn was started.",
      );

      await vi.advanceTimersByTimeAsync(
        MESSAGE_SEND_PREPARATION_TIMEOUT_MS,
      );
      await rejection;

      expect(abortObserved).toHaveBeenCalledOnce();
      expect(handlerDependencies.turns.queue).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects safely when aggregate preparation reaches its deadline", async () => {
    vi.useFakeTimers();
    try {
      const relinquishAll = vi.fn(async () => undefined);
      const queue = vi.fn();
      const handlerDependencies = dependencies({
        queue,
        relinquishAll,
        readiness: vi.fn(() => new Promise(() => undefined)),
      });
      const handling = createTurnInteractionCommandHandler(
        handlerDependencies,
      )({} as never, messageCommand());
      const rejection = expect(handling).rejects.toThrow(
        "Preparing this message took too long. No turn was started.",
      );

      await vi.advanceTimersByTimeAsync(
        MESSAGE_SEND_PREPARATION_TIMEOUT_MS,
      );
      await rejection;

      expect(queue).not.toHaveBeenCalled();
      expect(relinquishAll).toHaveBeenCalledWith([trustedAttachment.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts durable retention at the aggregate preparation deadline", async () => {
    vi.useFakeTimers();
    try {
      const relinquishAll = vi.fn(async () => undefined);
      const handlerDependencies = dependencies({
        queue: vi.fn(),
        relinquishAll,
        enableProviders: false,
      });
      const abortObserved = vi.fn();
      vi.mocked(handlerDependencies.conversationAttachments.retain)
        .mockImplementation((_payloads, signal) => new Promise(
          (_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              abortObserved();
              reject(signal.reason);
            }, { once: true });
          },
        ));
      const handling = createTurnInteractionCommandHandler(
        handlerDependencies,
      )({} as never, messageCommand());
      const rejection = expect(handling).rejects.toThrow(
        "Preparing this message took too long. No turn was started.",
      );

      await vi.advanceTimersByTimeAsync(
        MESSAGE_SEND_PREPARATION_TIMEOUT_MS,
      );
      await rejection;

      expect(abortObserved).toHaveBeenCalledOnce();
      expect(handlerDependencies.turns.queue).not.toHaveBeenCalled();
      expect(handlerDependencies.store.createMessage).not.toHaveBeenCalled();
      expect(relinquishAll).toHaveBeenCalledWith([trustedAttachment.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases durable retention that completes after its deadline", async () => {
    vi.useFakeTimers();
    try {
      const handlerDependencies = dependencies({
        queue: vi.fn(),
        relinquishAll: vi.fn(async () => undefined),
        enableProviders: false,
      });
      let completeRetention!: (attachments: ChatAttachment[]) => void;
      vi.mocked(handlerDependencies.conversationAttachments.retain)
        .mockReturnValue(new Promise((resolve) => {
          completeRetention = resolve;
        }));
      const handling = createTurnInteractionCommandHandler(
        handlerDependencies,
      )({} as never, messageCommand());
      const rejection = expect(handling).rejects.toThrow(
        "Preparing this message took too long. No turn was started.",
      );

      await vi.advanceTimersByTimeAsync(
        MESSAGE_SEND_PREPARATION_TIMEOUT_MS,
      );
      await rejection;

      completeRetention([{ ...trustedAttachment, path: "/durable/reference.png" }]);
      await vi.waitFor(() => {
        expect(handlerDependencies.conversationAttachments.releaseRetention)
          .toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f-]{36}$/u));
      });
      expect(handlerDependencies.turns.queue).not.toHaveBeenCalled();
      expect(handlerDependencies.store.createMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("projects an active follow-up without hydrating the live stream", async () => {
    const followUp: ChatMessage = {
      id: "77777777-7777-4777-8777-777777777777",
      conversationId,
      turnId: "88888888-8888-4888-8888-888888888888",
      role: "user",
      content: "Check the Windows edge too.",
      attachments: [],
      createdAt: "2026-07-30T06:00:00.000Z",
    };
    const handlerDependencies = dependencies({
      queue: vi.fn(),
      relinquishAll: vi.fn(async () => undefined),
    });
    vi.mocked(handlerDependencies.turns.isActive).mockReturnValue(true);
    vi.mocked(handlerDependencies.turns.steer).mockResolvedValue(followUp);
    const command = messageCommand();
    command.payload.attachments = [];
    command.payload.content = followUp.content;

    await expect(
      createTurnInteractionCommandHandler(handlerDependencies)(
        {} as never,
        command,
      ),
    ).resolves.toBe("handled");

    expect(handlerDependencies.broadcast).toHaveBeenCalledWith({
      type: "conversation.message.persisted",
      message: followUp,
    });
    expect(handlerDependencies.broadcast).toHaveBeenCalledTimes(1);
    expect(handlerDependencies.send).toHaveBeenCalledWith(expect.anything(), {
      type: "request.result",
      requestId: command.requestId,
      result: {
        kind: "message.accepted",
        conversationId,
        turnId: followUp.turnId,
        userMessageId: followUp.id,
        disposition: "follow-up",
      },
    });
    expect(handlerDependencies.broadcast).not.toHaveBeenCalledWith({
      type: "conversation.detail.invalidated",
      conversationId,
    });
    expect(handlerDependencies.broadcastSnapshot).toHaveBeenCalledOnce();
  });

  it("does not encourage a duplicate retry after follow-up persistence", async () => {
    const followUp: ChatMessage = {
      id: "77777777-7777-4777-8777-777777777777",
      conversationId,
      turnId: "88888888-8888-4888-8888-888888888888",
      role: "user",
      content: "Persisted follow-up.",
      attachments: [],
      createdAt: "2026-07-30T06:00:00.000Z",
    };
    const runtime = dependencies({
      queue: vi.fn(),
      relinquishAll: vi.fn(async () => undefined),
    });
    vi.mocked(runtime.turns.isActive).mockReturnValue(true);
    vi.mocked(runtime.turns.steer).mockResolvedValue(followUp);
    vi.mocked(runtime.send).mockImplementationOnce(() => {
      throw new Error("injected acknowledgement failure");
    });
    const command = messageCommand();
    command.payload.attachments = [];

    await expect(createTurnInteractionCommandHandler(runtime)(
      {} as never,
      command,
    )).rejects.toThrow(
      "The follow-up was accepted but its acknowledgement could not finish cleanly. Refresh this chat before retrying. [message-send/follow-up-publication/unexpected]",
    );
    expect(runtime.turns.queue).not.toHaveBeenCalled();
  });

  it("queues providers against the retained copy and persists its identity", async () => {
    const queue = vi.fn(() => queuedTurn());
    const relinquishAll = vi.fn(async () => undefined);
    const handlerDependencies = dependencies({ queue, relinquishAll });
    const retainedAttachment: ChatAttachment = {
      ...trustedAttachment,
      path: "/private/conversation-attachments/request.png",
    };
    vi.mocked(handlerDependencies.conversationAttachments.retain)
      .mockResolvedValueOnce([retainedAttachment]);

    await expect(createTurnInteractionCommandHandler(handlerDependencies)(
      {} as never,
      messageCommand(),
    )).resolves.toBe("handled");

    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [retainedAttachment],
        imagePaths: [retainedAttachment.path],
      }),
      expect.any(Function),
      expect.objectContaining({ conversationId }),
    );
    expect(relinquishAll).not.toHaveBeenCalled();
    expect(handlerDependencies.conversationAttachments.acceptRetention)
      .toHaveBeenCalledOnce();
    expect(handlerDependencies.conversationAttachments.releaseRetention)
      .not.toHaveBeenCalled();
  });

  it("relinquishes ownership when provider readiness rejects the send", async () => {
    const relinquishAll = vi.fn(async () => undefined);
    const queue = vi.fn();
    const handlerDependencies = dependencies({
      queue,
      relinquishAll,
      readiness: vi.fn(async () => ({
        ready: false,
        message: "Selected backend is unavailable.",
      })),
    });
    const handler = createTurnInteractionCommandHandler(handlerDependencies);

    await expect(handler({} as never, messageCommand())).rejects.toThrow(
      "Selected backend is unavailable.",
    );
    expect(queue).not.toHaveBeenCalled();
    expect(relinquishAll).toHaveBeenCalledOnce();
    expect(relinquishAll).toHaveBeenCalledWith([trustedAttachment.id]);
    expect(handlerDependencies.conversationAttachments.releaseRetention)
      .not.toHaveBeenCalled();
  });

  it("keeps a rejected capability available for a renderer retry", async () => {
    const relinquishAll = vi.fn(async () => undefined);
    const queue = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("queue preparation rejected");
      })
      .mockImplementationOnce(() => queuedTurn());
    const handlerDependencies = dependencies({
      queue,
      relinquishAll,
    });
    const handler = createTurnInteractionCommandHandler(handlerDependencies);

    await expect(handler({} as never, messageCommand())).rejects.toThrow(
      "message-send/turn-persistence/unexpected",
    );
    expect(queue).toHaveBeenCalledTimes(1);
    expect(relinquishAll).toHaveBeenCalledOnce();
    expect(relinquishAll).toHaveBeenCalledWith([trustedAttachment.id]);
    expect(handlerDependencies.conversationAttachments.releaseRetention)
      .toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f-]{36}$/u));

    await expect(handler({} as never, messageCommand())).resolves.toBe(
      "handled",
    );
    expect(queue).toHaveBeenCalledTimes(2);
    expect(queue).toHaveBeenLastCalledWith(
      expect.objectContaining({
        attachments: [trustedAttachment],
      }),
      expect.any(Function),
      expect.objectContaining({ conversationId }),
    );
    expect(relinquishAll).toHaveBeenCalledOnce();
    expect(handlerDependencies.conversationAttachments.retain)
      .toHaveBeenCalledTimes(2);
  });

  it("keeps retention accepted when live queue adoption fails after persistence", async () => {
    const queue = vi.fn((
      _request: unknown,
      onPersisted: () => void,
    ) => {
      onPersisted();
      throw new Error("queue adoption failed after persistence");
    });
    const relinquishAll = vi.fn(async () => undefined);
    const handlerDependencies = dependencies({ queue, relinquishAll });

    await expect(createTurnInteractionCommandHandler(handlerDependencies)(
      {} as never,
      messageCommand(),
    )).rejects.toThrow("message-send/turn-publication/unexpected");

    expect(handlerDependencies.conversationAttachments.acceptRetention)
      .toHaveBeenCalledOnce();
    expect(handlerDependencies.conversationAttachments.releaseRetention)
      .not.toHaveBeenCalled();
    expect(relinquishAll).toHaveBeenCalledWith([trustedAttachment.id]);
  });

  it("rejects stale skills before attempting a reversal checkpoint", async () => {
    const relinquishAll = vi.fn(async () => undefined);
    const queue = vi.fn();
    const resolveSkills = vi.fn(async () => {
      throw new RuntimeRequestError("Selected skill is no longer available.");
    });
    const handlerDependencies = dependencies({
      queue,
      relinquishAll,
      resolveSkills,
    });
    const command = messageCommand();
    command.payload.content = "$review Please inspect this change.";
    const handler = createTurnInteractionCommandHandler(handlerDependencies);

    await expect(handler({} as never, command)).rejects.toThrow(
      "Selected skill is no longer available.",
    );
    expect(resolveSkills).toHaveBeenCalledWith(
      conversationId,
      "$review Please inspect this change.",
    );
    expect(handlerDependencies.store.conversationPath).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(relinquishAll).toHaveBeenCalledWith([trustedAttachment.id]);
  });

  it("revalidates skills before checkpoint work and passes them to the turn", async () => {
    const skill = {
      source: "codex-native" as const,
      name: "review",
      path: "/workspace/project/.codex/skills/review/SKILL.md",
    };
    const resolveSkills = vi.fn(async () => [skill]);
    const queue = vi.fn(() => queuedTurn());
    const handlerDependencies = dependencies({
      queue,
      relinquishAll: vi.fn(async () => undefined),
      resolveSkills,
    });
    const command = messageCommand();
    command.payload.content = "$review Please inspect this change.";
    const handler = createTurnInteractionCommandHandler(handlerDependencies);

    await expect(handler({} as never, command)).resolves.toBe("handled");
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({ skills: [skill] }),
      expect.any(Function),
      expect.objectContaining({ conversationId }),
    );
    expect(resolveSkills.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(handlerDependencies.store.conversationPath)
        .mock.invocationCallOrder[0]!,
    );
    expect(
      vi.mocked(handlerDependencies.workflows.assertTurnSkillsCurrent)
        .mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(handlerDependencies.providerTerminalResumes.acquireWhenAvailable)
        .mock.invocationCallOrder[0]!,
    );
    expect(
      vi.mocked(handlerDependencies.providerTerminalResumes.acquireWhenAvailable)
        .mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(handlerDependencies.store.conversationPath)
        .mock.invocationCallOrder[0]!,
    );
    expect(
      vi.mocked(handlerDependencies.turns.start).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(handlerDependencies.providerTerminalResumes.release)
        .mock.invocationCallOrder[0]!,
    );
    expect(handlerDependencies.broadcast).toHaveBeenCalledWith({
      type: "conversation.detail.invalidated",
      conversationId,
    });
  });

  it("retains, delivers, persists, and releases an acknowledged image follow-up", async () => {
    const durableAttachment = {
      ...trustedAttachment,
      path: "/private/conversation-attachments/request.png",
    };
    const relinquishAll = vi.fn(async () => undefined);
    const handlerDependencies = dependencies({
      queue: vi.fn(),
      relinquishAll,
    });
    const releaseAll = vi.mocked(
      handlerDependencies.attachmentResolver!.releaseAll,
    );
    vi.mocked(handlerDependencies.turns.isActive).mockReturnValue(true);
    vi.mocked(handlerDependencies.conversationAttachments.retain)
      .mockResolvedValue([durableAttachment]);
    vi.mocked(handlerDependencies.turns.steer).mockImplementation(async (
      _lease,
      input,
      attachments,
      acknowledge,
    ) => {
      expect(input).toEqual({
        content: "Use the selected attachment.",
        imagePaths: [durableAttachment.path],
      });
      expect(attachments).toEqual([durableAttachment]);
      acknowledge?.();
      return {
        id: "77777777-7777-4777-8777-777777777777",
        conversationId,
        turnId: "88888888-8888-4888-8888-888888888888",
        role: "user",
        content: input.content,
        attachments: [...(attachments ?? [])],
        createdAt: "2026-07-30T06:00:00.000Z",
      };
    });

    await expect(createTurnInteractionCommandHandler(handlerDependencies)(
      {} as never,
      messageCommand(),
    )).resolves.toBe("handled");

    expect(handlerDependencies.conversationAttachments.acceptRetention)
      .toHaveBeenCalledOnce();
    expect(releaseAll).toHaveBeenCalledWith([trustedAttachment.id]);
    expect(releaseAll).toHaveBeenCalledOnce();
    expect(relinquishAll).not.toHaveBeenCalled();
    expect(handlerDependencies.broadcast).toHaveBeenCalledWith({
      type: "conversation.message.persisted",
      message: expect.objectContaining({ attachments: [durableAttachment] }),
    });
  });

  it("rolls back the exact image claim when the live provider rejects a follow-up", async () => {
    const relinquishAll = vi.fn(async () => undefined);
    const handlerDependencies = dependencies({
      queue: vi.fn(),
      relinquishAll,
    });
    vi.mocked(handlerDependencies.turns.isActive).mockReturnValue(true);
    vi.mocked(handlerDependencies.turns.steer).mockResolvedValue(null);

    await expect(createTurnInteractionCommandHandler(handlerDependencies)(
      {} as never,
      messageCommand(),
    )).rejects.toThrow("cannot accept a follow-up");

    expect(handlerDependencies.conversationAttachments.releaseRetention)
      .toHaveBeenCalledOnce();
    expect(relinquishAll).toHaveBeenCalledWith([trustedAttachment.id]);
    expect(handlerDependencies.attachmentResolver!.releaseAll)
      .not.toHaveBeenCalled();
  });

  it("preserves literal skill tokens in active follow-ups without claiming a new capability", async () => {
    const handlerDependencies = dependencies({
      queue: vi.fn(),
      relinquishAll: vi.fn(async () => undefined),
    });
    vi.mocked(handlerDependencies.turns.isActive).mockReturnValue(true);
    vi.mocked(handlerDependencies.turns.steer).mockImplementation(async (
      _lease,
      input,
    ) => ({
      id: "77777777-7777-4777-8777-777777777777",
      conversationId,
      turnId: "88888888-8888-4888-8888-888888888888",
      role: "user",
      content: input.content,
      attachments: [],
      createdAt: "2026-07-30T06:00:00.000Z",
    }));
    const command = messageCommand();
    command.payload.content = "$security-review inspect the latest patch";
    command.payload.attachments = [];

    await expect(createTurnInteractionCommandHandler(handlerDependencies)(
      {} as never,
      command,
    )).resolves.toBe("handled");

    expect(handlerDependencies.turns.steer).toHaveBeenCalledWith(
      expect.anything(),
      {
        content: "$security-review inspect the latest patch",
        imagePaths: [],
      },
      [],
      expect.any(Function),
    );
    expect(handlerDependencies.workflows.resolveTurnSkills)
      .not.toHaveBeenCalled();
  });

  it("rolls back accepted durable images when follow-up persistence fails", async () => {
    const relinquishAll = vi.fn(async () => undefined);
    const handlerDependencies = dependencies({ queue: vi.fn(), relinquishAll });
    vi.mocked(handlerDependencies.turns.isActive).mockReturnValue(true);
    vi.mocked(handlerDependencies.turns.steer).mockImplementation(async (
      _lease,
      _input,
      _attachments,
      acknowledge,
    ) => {
      acknowledge?.();
      return null;
    });

    await expect(createTurnInteractionCommandHandler(handlerDependencies)(
      {} as never,
      messageCommand(),
    )).rejects.toThrow("cannot accept a follow-up");

    expect(handlerDependencies.conversationAttachments.release)
      .toHaveBeenCalledWith([trustedAttachment.id]);
    expect(handlerDependencies.conversationAttachments.releaseRetention)
      .not.toHaveBeenCalled();
    expect(handlerDependencies.attachmentResolver!.releaseAll)
      .toHaveBeenCalledWith([trustedAttachment.id]);
    expect(relinquishAll).not.toHaveBeenCalled();
  });

  it("rejects follow-up documents and immutable non-image active models before delivery", async () => {
    const document = {
      attachment: {
        ...trustedAttachment,
        name: "notes.pdf",
        mimeType: "application/pdf" as const,
      },
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    };
    const relinquishAll = vi.fn(async () => undefined);
    const handlerDependencies = dependencies({
      queue: vi.fn(),
      relinquishAll,
      resolvedPayloads: [document],
    });
    vi.mocked(handlerDependencies.turns.isActive).mockReturnValue(true);
    const documentCommand = messageCommand();
    documentCommand.payload.attachments = [document.attachment];

    await expect(createTurnInteractionCommandHandler(handlerDependencies)(
      {} as never,
      documentCommand,
    )).rejects.toThrow("support images only");
    expect(relinquishAll).toHaveBeenCalledWith([document.attachment.id]);
    expect(handlerDependencies.turns.steer).not.toHaveBeenCalled();

    const admission = vi.mocked(
      handlerDependencies.turns.acquireFollowUpAdmission,
    ).mock.results[0]?.value;
    vi.mocked(handlerDependencies.turns.acquireFollowUpAdmission)
      .mockReturnValue({ ...admission, supportsImages: false });
    await expect(createTurnInteractionCommandHandler(handlerDependencies)(
      {} as never,
      messageCommand(),
    )).rejects.toThrow("active model cannot inspect follow-up images");
  });

  it("rejects a changed skill route before persisting its checkpoint", async () => {
    const repository = await mkdtemp(join(tmpdir(), "inertia-skill-route-"));
    try {
      await execFileAsync("git", ["init", "--quiet", repository]);
      await writeFile(join(repository, "request.txt"), "pending\n");
      const relinquishAll = vi.fn(async () => undefined);
      const queue = vi.fn();
      const assertTurnSkillsCurrent = vi.fn(() => {
        throw new RuntimeRequestError("The provider route changed.");
      });
      const handlerDependencies = dependencies({
        queue,
        relinquishAll,
        conversationPath: repository,
        resolveSkills: vi.fn(async () => [{
          source: "codex-native" as const,
          name: "review",
          path: join(repository, ".codex", "skills", "review", "SKILL.md"),
        }]),
        assertTurnSkillsCurrent,
      });
      const command = messageCommand();
      command.payload.content = "$review Please inspect this change.";
      const handler = createTurnInteractionCommandHandler(
        handlerDependencies,
      );

      await expect(handler({} as never, command)).rejects.toThrow(
        "The provider route changed.",
      );
      expect(assertTurnSkillsCurrent).toHaveBeenCalledWith(
        conversationId,
        "test-route",
      );
      expect(handlerDependencies.store.addCheckpoint).not.toHaveBeenCalled();
      expect(queue).not.toHaveBeenCalled();
      expect(relinquishAll).toHaveBeenCalledWith([trustedAttachment.id]);
      const { stdout } = await execFileAsync("git", [
        "-C",
        repository,
        "for-each-ref",
        "--format=%(refname)",
        `refs/inertia/checkpoints/${conversationId}/`,
      ]);
      expect(stdout.trim()).toBe("");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("removes a captured checkpoint when its metadata cannot be counted", async () => {
    const repository = await mkdtemp(join(tmpdir(), "inertia-checkpoint-count-"));
    try {
      await execFileAsync("git", ["init", "--quiet", repository]);
      await writeFile(join(repository, "request.txt"), "pending\n");
      const queue = vi.fn(() => queuedTurn());
      const handlerDependencies = dependencies({
        queue,
        relinquishAll: vi.fn(async () => undefined),
        conversationPath: repository,
        checkpointCount: vi.fn(() => {
          throw new Error("checkpoint count unavailable");
        }),
      });
      const handler = createTurnInteractionCommandHandler(
        handlerDependencies,
      );

      await expect(handler({} as never, messageCommand())).resolves.toBe(
        "handled",
      );
      expect(handlerDependencies.store.addCheckpoint).not.toHaveBeenCalled();
      expect(queue).toHaveBeenCalledOnce();
      const { stdout } = await execFileAsync("git", [
        "-C",
        repository,
        "for-each-ref",
        "--format=%(refname)",
        `refs/inertia/checkpoints/${conversationId}/`,
      ]);
      expect(stdout.trim()).toBe("");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("removes a captured checkpoint when durable attachment retention fails", async () => {
    const repository = await mkdtemp(join(tmpdir(), "inertia-attachment-retain-"));
    try {
      await execFileAsync("git", ["init", "--quiet", repository]);
      await writeFile(join(repository, "request.txt"), "pending\n");
      const handlerDependencies = dependencies({
        queue: vi.fn(),
        relinquishAll: vi.fn(async () => undefined),
        conversationPath: repository,
      });
      vi.mocked(handlerDependencies.conversationAttachments.retain)
        .mockRejectedValueOnce(new Error(
          "Conversation attachment storage is full.",
        ));

      await expect(createTurnInteractionCommandHandler(handlerDependencies)(
        {} as never,
        messageCommand(),
      )).rejects.toThrow("message-send/retention/unexpected");

      expect(handlerDependencies.store.addCheckpoint).not.toHaveBeenCalled();
      expect(handlerDependencies.turns.queue).not.toHaveBeenCalled();
      expect(handlerDependencies.attachmentResolver?.relinquishAll)
        .toHaveBeenCalledWith([trustedAttachment.id]);
      expect(handlerDependencies.conversationAttachments.releaseRetention)
        .toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f-]{36}$/u));
      const { stdout } = await execFileAsync("git", [
        "-C",
        repository,
        "for-each-ref",
        "--format=%(refname)",
        `refs/inertia/checkpoints/${conversationId}/`,
      ]);
      expect(stdout.trim()).toBe("");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("removes unassociated checkpoint metadata and its ref before turn persistence", async () => {
    const repository = await mkdtemp(join(tmpdir(), "inertia-checkpoint-queue-"));
    try {
      await execFileAsync("git", ["init", "--quiet", repository]);
      await writeFile(join(repository, "request.txt"), "pending\n");
      const handlerDependencies = dependencies({
        queue: vi.fn(() => {
          throw new Error("injected queue persistence failure");
        }),
        relinquishAll: vi.fn(async () => undefined),
        conversationPath: repository,
      });

      await expect(createTurnInteractionCommandHandler(handlerDependencies)(
        {} as never,
        messageCommand(),
      )).rejects.toThrow("message-send/turn-persistence/unexpected");

      expect(handlerDependencies.store.addCheckpoint).toHaveBeenCalledOnce();
      expect(handlerDependencies.store.removeUnassociatedCheckpoint)
        .toHaveBeenCalledWith(
          "55555555-5555-4555-8555-555555555555",
          conversationId,
        );
      const { stdout } = await execFileAsync("git", [
        "-C",
        repository,
        "for-each-ref",
        "--format=%(refname)",
        `refs/inertia/checkpoints/${conversationId}/`,
      ]);
      expect(stdout.trim()).toBe("");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("does not release after an authoritative turn accepts ownership", async () => {
    const relinquishAll = vi.fn(async () => undefined);
    const queue = vi.fn(() => queuedTurn());
    const handlerDependencies = dependencies({ queue, relinquishAll });
    const handler = createTurnInteractionCommandHandler(handlerDependencies);

    await expect(handler({} as never, messageCommand())).resolves.toBe(
      "handled",
    );
    expect(relinquishAll).not.toHaveBeenCalled();
    expect(handlerDependencies.turns.start).toHaveBeenCalledWith(
      "44444444-4444-4444-8444-444444444444",
    );
    expect(handlerDependencies.send).toHaveBeenCalledWith(expect.anything(), {
      type: "request.result",
      requestId: messageCommand().requestId,
      result: {
        kind: "message.accepted",
        conversationId,
        turnId: "44444444-4444-4444-8444-444444444444",
        userMessageId: "99999999-9999-4999-8999-999999999999",
        disposition: "new-turn",
      },
    });
  });

  it("preserves a background conversation when queueing a split-pane turn", async () => {
    const queue = vi.fn(() => queuedTurn());
    const handlerDependencies = dependencies({
      queue,
      relinquishAll: vi.fn(async () => undefined),
    });
    const handler = createTurnInteractionCommandHandler(handlerDependencies);

    await expect(handler({} as never, messageCommand(false))).resolves.toBe(
      "handled",
    );
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId,
        activateConversation: false,
      }),
      expect.any(Function),
      expect.objectContaining({ conversationId }),
    );
  });

  it("settles an accepted queued turn if acknowledgement work throws before start", async () => {
    const relinquishAll = vi.fn(async () => undefined);
    const queue = vi.fn(() => queuedTurn(
      "55555555-5555-4555-8555-555555555555",
    ));
    const handlerDependencies = dependencies({
      queue,
      relinquishAll,
    });
    vi.mocked(handlerDependencies.send).mockImplementation(() => {
      throw new Error("renderer acknowledgement failed");
    });
    const handler = createTurnInteractionCommandHandler(handlerDependencies);

    await expect(handler({} as never, messageCommand())).rejects.toThrow(
      "message-send/turn-publication/unexpected",
    );
    expect(handlerDependencies.turns.failBeforeStart).toHaveBeenCalledWith(
      conversationId,
      "renderer acknowledgement failed",
    );
    expect(relinquishAll).not.toHaveBeenCalled();
  });
});
