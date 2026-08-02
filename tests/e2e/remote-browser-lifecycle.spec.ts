import {
  expect,
  test,
  type Page,
} from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";

import { WebSocket } from "ws";

import {
  createReferenceRelay,
  type ReferenceRelay,
} from "../../remote/relay/server.mjs";
import {
  createAuthenticatedSessionRecipient,
  createAuthenticatedSessionSender,
  generateRemoteKeyPair,
  importRemoteKeyPair,
  importRemotePublicKey,
  openSessionData,
  openSessionHandshake,
  remoteRandomSecret,
  sealSessionData,
  sealSessionHandshake,
} from "../../src/shared/remote-crypto";
import {
  RELAY_PROTOCOL_VERSION,
  remoteCipherFrameSchema,
  remoteRequestSchema,
  type RemoteRequest,
  type RemoteSafeConversationDetail,
  type RemoteSafeShell,
} from "../../src/shared/remote-protocol";
import {
  lifecycleDetail,
  seedBrowserProfile,
  serveBrowserAsset,
  type SeededBrowserProfile,
} from "./support/remote-browser-fixtures";
import { launchRemoteBrowser } from "./support/remote-browser-electron-fixture";
import { registerRelayDesktop } from "./support/remote-relay-v2";

let staticServer: Server;
let staticUrl: string;
let relay: ReferenceRelay;
let relayUrl: string;
let desktop: WebSocket;
let navigationSequence = 0;
let relayStateDirectory: string;
let endpointKeyPair: Awaited<
  ReturnType<typeof registerRelayDesktop>
>["endpointKeyPair"] | undefined;
let relayIdentity: string | undefined;

test.beforeAll(async () => {
  relayStateDirectory = await mkdtemp(join(
    tmpdir(),
    "inertia-remote-e2e-relay-",
  ));
  const root = resolve("remote/browser/dist");
  staticServer = createServer((request, response) => {
    void serveBrowserAsset(root, request, response);
  });
  staticServer.listen(0, "127.0.0.1");
  await once(staticServer, "listening");
  const staticAddress = staticServer.address();
  if (!staticAddress || typeof staticAddress === "string") {
    throw new Error("Browser test server did not bind.");
  }
  staticUrl = `http://127.0.0.1:${staticAddress.port}`;

  relay = await createReferenceRelay({
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: [staticUrl],
    stateDirectory: relayStateDirectory,
    initializeState: true,
  });
  const relayAddress = relay.address();
  if (!relayAddress) throw new Error("Relay did not bind.");
  relayUrl = `ws://127.0.0.1:${relayAddress.port}/remote`;
});

test.afterAll(async () => {
  desktop?.terminate();
  await relay.close();
  await rm(relayStateDirectory, { recursive: true, force: true });
  await new Promise<void>((resolveClose) =>
    staticServer.close(() => resolveClose()));
});

test("recovers truthful state across browser, desktop, and relay lifecycles", async () => {
  const browser = await launchRemoteBrowser({ staticUrl });
  const { electronApp, page } = browser;
  const hostKeys = await generateRemoteKeyPair();
  const hostId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const endpointId = remoteRandomSecret(24);
  const conversationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const shell = {
    generatedAt: now,
    projects: [{ id: "safe-project", name: "Lifecycle project" }],
    conversations: [{
      id: conversationId,
      projectId: "safe-project",
      title: "Lifecycle conversation",
      providerLabel: "Provider",
      status: "idle" as const,
      pendingLocalApproval: false,
      promptSafety: {
        supported: true as const,
        headline: "Local approval required for reported actions",
        explanation: "Desktop approval is required for reported actions.",
      },
      updatedAt: now,
    }],
    runs: [],
  };
  const relayAddress = relay.address();
  if (!relayAddress) throw new Error("Relay is unavailable.");
  const restartPort = relayAddress.port;
  desktop?.terminate();
  desktop = await registerDesktop(endpointId, relayUrl);
  try {
    await expect(page.getByRole("heading", { name: "Pair this browser" }))
      .toBeVisible();
    const profile = await seedBrowserProfile(page, {
      hostPublicKey: hostKeys.publicKey,
      relayUrl,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      hostId,
      deviceId,
      endpointId,
      relayIdentity: relayIdentity!,
      scopes: ["view", "prompt"],
    });
    const initialSession = acceptSeededSession(
      profile,
      hostKeys,
      shell,
      undefined,
      "initial session",
    );
    await navigateRemoteBrowser(page, "initial-profile");
    let session = await initialSession;
    await expect(page.getByText("Lifecycle project")).toBeVisible();

    const detailRequest = nextRequestOfType(
      session,
      "conversation.get",
      shell,
    );
    await page.getByRole("button", {
      name: "Lifecycle conversation · idle",
    }).click();
    const selected = await detailRequest;
    expect(selected.type).toBe("conversation.get");
    await sendSessionResponse(session, selected.requestId, {
      kind: "conversation",
      detail: lifecycleDetail(shell.conversations[0]!, 40, now),
    });
    await expect(page.getByLabel("Text prompt")).toBeVisible();
    await page.evaluate(() => {
      const prompt = document.querySelector<HTMLTextAreaElement>(
        "#remote-prompt-input",
      )!;
      prompt.focus();
      prompt.value = "Half typed lifecycle prompt";
      prompt.setSelectionRange(5, 12);
      const disclosure = document.querySelector("details")!;
      disclosure.open = true;
      const transcript = document.querySelector<HTMLElement>(".transcript")!;
      transcript.scrollTop = 120;
      (window as unknown as Record<string, unknown>).__remoteIdentity = {
        prompt,
        disclosure,
        firstMessage: document.querySelector(
          '[data-remote-key="message:message-0"]',
        ),
        navigation: document.querySelector(".selected"),
        scrollTop: transcript.scrollTop,
      };
    });

    const resumedState = nextSessionRequest(session);
    await page.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const stateRequest = await resumedState;
    expect(stateRequest.type).toBe("state.get");
    await sendSessionResponse(session, stateRequest.requestId, {
      kind: "state",
      state: { ...shell, generatedAt: new Date().toISOString() },
    });
    const resumedDetail = await nextSessionRequest(session);
    expect(resumedDetail.type).toBe("conversation.get");
    await sendSessionResponse(session, resumedDetail.requestId, {
      kind: "conversation",
      detail: lifecycleDetail(shell.conversations[0]!, 41, now),
    });
    await expect.poll(async () => await page.evaluate(() => {
      const retained = (window as unknown as {
        __remoteIdentity: Record<string, unknown>;
      }).__remoteIdentity;
      const prompt = document.querySelector<HTMLTextAreaElement>(
        "#remote-prompt-input",
      )!;
      const transcript = document.querySelector<HTMLElement>(".transcript")!;
      return {
        prompt: retained.prompt === prompt,
        disclosure: retained.disclosure === document.querySelector("details"),
        message: retained.firstMessage === document.querySelector(
          '[data-remote-key="message:message-0"]',
        ),
        navigation: retained.navigation === document.querySelector(".selected"),
        focused: document.activeElement === prompt,
        selection: [prompt.selectionStart, prompt.selectionEnd],
        open: document.querySelector("details")?.open,
        scrollTop: transcript.scrollTop,
      };
    })).toMatchObject({
      prompt: true,
      disclosure: true,
      message: true,
      navigation: true,
      focused: true,
      selection: [5, 12],
      open: true,
      scrollTop: 120,
    });

    const conversationButton = page.getByRole("button", {
      name: "Lifecycle conversation · idle",
    });
    await conversationButton.focus();
    await page.evaluate(() => {
      const text = document.querySelector(
        '[data-remote-key="message:message-0"] .message-content',
      )?.firstChild;
      if (!text) throw new Error("Transcript text is missing.");
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 5);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      (window as unknown as Record<string, unknown>).__remoteSelectedText = text;
    });
    const focusedNavigationState = nextRequestOfType(
      session,
      "state.get",
      shell,
      lifecycleDetail(shell.conversations[0]!, 41, now),
    );
    await page.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const focusedState = await focusedNavigationState;
    await sendSessionResponse(session, focusedState.requestId, {
      kind: "state",
      state: { ...shell, generatedAt: new Date().toISOString() },
    });
    const focusedDetail = await nextSessionRequest(session);
    await sendSessionResponse(session, focusedDetail.requestId, {
      kind: "conversation",
      detail: lifecycleDetail(shell.conversations[0]!, 41, now),
    });
    await expect(conversationButton).toBeFocused();
    await expect.poll(async () => await page.evaluate(() => {
      const selection = window.getSelection();
      return {
        text: selection?.toString(),
        identity: selection?.anchorNode === (
          window as unknown as Record<string, unknown>
        ).__remoteSelectedText,
      };
    })).toEqual({ text: "Lifec", identity: true });

    const promptRequest = nextRequestOfType(
      session,
      "prompt.send",
      shell,
      lifecycleDetail(shell.conversations[0]!, 41, now),
    );
    await page.getByLabel("Text prompt").fill("One-shot prompt");
    await page.getByRole("button", { name: "Send to desktop" }).click();
    const oneShot = await promptRequest;
    expect(oneShot.type).toBe("prompt.send");

    await relay.close();
    await expect(page.getByText(/Delivery is uncertain/u)).toBeVisible();
    relay = await createReferenceRelay({
      host: "127.0.0.1",
      port: restartPort,
      allowedOrigins: [staticUrl],
      stateDirectory: relayStateDirectory,
    });
    relayUrl = `ws://127.0.0.1:${restartPort}/remote`;
    desktop = await registerDesktop(endpointId, relayUrl);
    session = await acceptSeededSession(
      profile,
      hostKeys,
      shell,
      lifecycleDetail(shell.conversations[0]!, 41, now),
      "relay restart",
    );
    await expect(page.getByText("Connected. The desktop remains authoritative."))
      .toBeVisible();

    await page.context().setOffline(true);
    await expect(page.getByText(/browser is offline/u)).toBeVisible();
    await expect(page.getByText(/Cached · last updated/u)).toBeVisible();
    await expect(page.getByLabel("Text prompt")).toBeDisabled();
    const onlineSession = acceptSeededSession(
      profile,
      hostKeys,
      shell,
      lifecycleDetail(shell.conversations[0]!, 41, now),
      "browser online",
    );
    await page.context().setOffline(false);
    session = await onlineSession;
    await expect(page.getByLabel("Text prompt")).toBeEnabled();

    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.hide();
    });
    const foregroundState = nextSessionRequest(session);
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.show();
    });
    const wakeState = await foregroundState;
    expect(wakeState.type).toBe("state.get");
    await sendSessionResponse(session, wakeState.requestId, {
      kind: "state",
      state: { ...shell, generatedAt: new Date().toISOString() },
    });
    const wakeDetail = await nextSessionRequest(session);
    await sendSessionResponse(session, wakeDetail.requestId, {
      kind: "conversation",
      detail: lifecycleDetail(shell.conversations[0]!, 41, now),
    });

    desktop.send(JSON.stringify({
      relayProtocolVersion: RELAY_PROTOCOL_VERSION,
      type: "relay.frame",
      connectionId: session.connectionId,
      frame: {
        protocolVersion: 2,
        kind: "session.close",
        sessionId: session.sessionId,
        reason: "shutdown",
      },
    }));
    desktop.terminate();
    await expect(page.getByText(/desktop is unavailable|desktop is offline/u))
      .toBeVisible();
    desktop = await registerDesktop(endpointId, relayUrl);
    session = await acceptSeededSession(
      profile,
      hostKeys,
      shell,
      lifecycleDetail(shell.conversations[0]!, 41, now),
      "desktop unlock",
    );
    await expect(page.getByText("Connected. The desktop remains authoritative."))
      .toBeVisible();

    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.hide();
    });
    const idleOpeningPromise = nextDesktopMessage((message) =>
      message.type === "relay.frame"
      && typeof message.frame === "object"
      && message.frame !== null
      && "kind" in message.frame
      && message.frame.kind === "session.open");
    desktop.send(JSON.stringify({
      relayProtocolVersion: RELAY_PROTOCOL_VERSION,
      type: "relay.frame",
      connectionId: session.connectionId,
      frame: {
        protocolVersion: 2,
        kind: "session.close",
        sessionId: session.sessionId,
        // The desktop uses this existing v2 reason for both grant expiry and
        // the >15 minute idle sweep. The still-valid grant must survive.
        reason: "expired",
      },
    }));
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.show();
    });
    await expect(page.getByText(/fresh authenticated session/u)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Lifecycle browser" }))
      .toBeVisible();
    await expect(page.getByText("Lifecycle project")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Pair this browser" }))
      .toHaveCount(0);
    session = await acceptSeededSession(
      profile,
      hostKeys,
      shell,
      lifecycleDetail(shell.conversations[0]!, 41, now),
      "idle session resume",
      await idleOpeningPromise,
    );
    await expect(page.getByText("Connected. The desktop remains authoritative."))
      .toBeVisible();

    const revokedOpeningPromise = nextDesktopMessage((message) =>
      message.type === "relay.frame"
      && typeof message.frame === "object"
      && message.frame !== null
      && "kind" in message.frame
      && message.frame.kind === "session.open");
    desktop.send(JSON.stringify({
      relayProtocolVersion: RELAY_PROTOCOL_VERSION,
      type: "relay.frame",
      connectionId: session.connectionId,
      frame: await sealSessionData(session.sender, session.sessionId, {
        type: "session.authority-changed",
        serverTime: new Date().toISOString(),
      }),
    }));
    await expect(page.getByText("Lifecycle project")).toHaveCount(0);
    await expect(page.locator("[data-remote-key]")).toHaveCount(0);
    desktop.send(JSON.stringify({
      relayProtocolVersion: RELAY_PROTOCOL_VERSION,
      type: "relay.frame",
      connectionId: session.connectionId,
      frame: {
        protocolVersion: 2,
        kind: "session.close",
        sessionId: session.sessionId,
        reason: "revoked",
      },
    }));
    await expect(page.getByText(/fresh authenticated session/u)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Lifecycle browser" }))
      .toBeVisible();
    await expect(page.getByRole("heading", { name: "Pair this browser" }))
      .toHaveCount(0);
    await rejectSeededOpening(
      await revokedOpeningPromise,
      profile,
      hostKeys,
      "revoked",
    );
    await expect(page.getByText(/revoked on the desktop/u)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Pair this browser" }))
      .toBeVisible();
    await expect(page.getByText("Lifecycle browser")).toHaveCount(0);
    await expect(page.locator("[data-remote-key]")).toHaveCount(0);
  } finally {
    await page.context().setOffline(false).catch(() => undefined);
    await browser.close();
  }
});

type SeededHostKeys = Awaited<ReturnType<typeof generateRemoteKeyPair>>;
type SessionRecipient = Awaited<
  ReturnType<typeof createAuthenticatedSessionRecipient>
>;
type SessionSender = Awaited<
  ReturnType<typeof createAuthenticatedSessionSender>
>;

interface SeededSession {
  connectionId: string;
  sessionId: string;
  recipient: SessionRecipient;
  sender: SessionSender;
}

async function registerDesktop(
  endpointId: string,
  url: string,
): Promise<WebSocket> {
  const registration = await registerRelayDesktop(
    endpointId,
    url,
    endpointKeyPair,
  );
  endpointKeyPair = registration.endpointKeyPair;
  if (relayIdentity && registration.relayIdentity !== relayIdentity) {
    throw new Error("Relay identity changed across restart.");
  }
  relayIdentity = registration.relayIdentity;
  return registration.socket;
}

async function acceptSeededSession(
  profile: SeededBrowserProfile,
  hostKeys: SeededHostKeys,
  shell: RemoteSafeShell,
  detail?: RemoteSafeConversationDetail,
  label = "seeded session",
  initialOpening?: Record<string, unknown>,
): Promise<SeededSession> {
  let opening = initialOpening ?? await nextDesktopMessage((message) =>
    message.type === "relay.frame"
    && typeof message.frame === "object"
    && message.frame !== null
    && "kind" in message.frame
    && message.frame.kind === "session.open").catch((error: unknown) => {
      throw new Error(`${label} opening failed: ${errorMessage(error)}`);
    });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (
      typeof opening.connectionId !== "string"
      || typeof opening.frame !== "object"
      || opening.frame === null
    ) throw new Error("Missing seeded session opening.");
    const frame = remoteCipherFrameSchema.parse(opening.frame);
    if (frame.kind !== "session.open") {
      throw new Error("Invalid seeded session opening.");
    }
    const hostKeyPair = await importRemoteKeyPair(hostKeys);
    const devicePublicKey = await importRemotePublicKey(profile.publicKey);
    const recipient = await createAuthenticatedSessionRecipient(
      profile.hostId,
      profile.deviceId,
      frame.sessionId,
      hostKeyPair,
      devicePublicKey,
      frame.enc,
    );
    expect(await openSessionHandshake(
      recipient,
      "session.open",
      frame.sessionId,
      frame.ciphertext,
    )).toMatchObject({
      deviceId: profile.deviceId,
      grantVersion: 1,
    });
    const sender = await createAuthenticatedSessionSender(
      profile.hostId,
      profile.deviceId,
      frame.sessionId,
      hostKeyPair,
      devicePublicKey,
    );
    const session: SeededSession = {
      connectionId: opening.connectionId,
      sessionId: frame.sessionId,
      recipient,
      sender,
    };
    const firstRequest = nextSessionRequestOrOpening(session);
    desktop.send(JSON.stringify({
      relayProtocolVersion: RELAY_PROTOCOL_VERSION,
      type: "relay.frame",
      connectionId: session.connectionId,
      frame: {
        protocolVersion: 2,
        kind: "session.accept",
        sessionId: session.sessionId,
        enc: sender.enc,
        ciphertext: await sealSessionHandshake(
          sender,
          "session.accept",
          session.sessionId,
          {
            type: "session.accept",
            sessionId: session.sessionId,
            hostId: profile.hostId,
            grantVersion: 1,
            scopes: ["view", "prompt"],
            projectIds: ["safe-project"],
            expiresAt: profile.expiresAt,
            serverTime: new Date().toISOString(),
          },
        ),
      },
    }));
    const outcome = await firstRequest.catch((error: unknown) => {
      throw new Error(`${label} state request failed: ${errorMessage(error)}`);
    });
    if ("opening" in outcome) {
      opening = outcome.opening;
      continue;
    }
    const request = outcome.request;
    expect(request.type).toBe("state.get");
    await sendSessionResponse(session, request.requestId, {
      kind: "state",
      state: shell,
    });
    if (detail) {
      const detailRequest = await nextSessionRequest(session);
      expect(detailRequest.type).toBe("conversation.get");
      await sendSessionResponse(session, detailRequest.requestId, {
        kind: "conversation",
        detail,
      });
    }
    return session;
  }
  throw new Error(`${label} exceeded the reconnect attempt limit.`);
}

async function rejectSeededOpening(
  opening: Record<string, unknown>,
  profile: SeededBrowserProfile,
  hostKeys: SeededHostKeys,
  reason: "revoked" | "expired",
): Promise<void> {
  if (
    typeof opening.connectionId !== "string"
    || typeof opening.frame !== "object"
    || opening.frame === null
  ) throw new Error("Missing rejected session opening.");
  const frame = remoteCipherFrameSchema.parse(opening.frame);
  if (frame.kind !== "session.open") {
    throw new Error("Invalid rejected session opening.");
  }
  const sender = await createAuthenticatedSessionSender(
    profile.hostId,
    profile.deviceId,
    frame.sessionId,
    await importRemoteKeyPair(hostKeys),
    await importRemotePublicKey(profile.publicKey),
  );
  desktop.send(JSON.stringify({
    relayProtocolVersion: RELAY_PROTOCOL_VERSION,
    type: "relay.frame",
    connectionId: opening.connectionId,
    frame: {
      protocolVersion: 2,
      kind: "session.accept",
      sessionId: frame.sessionId,
      enc: sender.enc,
      ciphertext: await sealSessionHandshake(
        sender,
        "session.accept",
        frame.sessionId,
        {
          type: "session.reject",
          sessionId: frame.sessionId,
          hostId: profile.hostId,
          reason,
          serverTime: new Date().toISOString(),
        },
      ),
    },
  }));
}

async function navigateRemoteBrowser(page: Page, label: string): Promise<void> {
  navigationSequence += 1;
  await page.goto(
    `${staticUrl}/?fixture=${encodeURIComponent(label)}-${navigationSequence}`,
    { waitUntil: "load" },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function nextSessionRequest(
  session: SeededSession,
): Promise<RemoteRequest> {
  const message = await nextDesktopMessage((candidate) =>
    candidate.type === "relay.frame"
    && candidate.connectionId === session.connectionId
    && typeof candidate.frame === "object"
    && candidate.frame !== null
    && "kind" in candidate.frame
    && candidate.frame.kind === "session.data");
  const frame = remoteCipherFrameSchema.parse(message.frame);
  if (frame.kind !== "session.data") {
    throw new Error("Missing encrypted session request.");
  }
  return remoteRequestSchema.parse(
    await openSessionData(session.recipient, frame),
  );
}

async function nextSessionRequestOrOpening(session: SeededSession): Promise<
  { request: RemoteRequest } | { opening: Record<string, unknown> }
> {
  const message = await nextDesktopMessage((candidate) =>
    candidate.type === "relay.frame"
    && typeof candidate.frame === "object"
    && candidate.frame !== null
    && "kind" in candidate.frame
    && (
      candidate.frame.kind === "session.open"
      || (
        candidate.connectionId === session.connectionId
        && candidate.frame.kind === "session.data"
      )
    ));
  const frame = remoteCipherFrameSchema.parse(message.frame);
  if (frame.kind === "session.open") return { opening: message };
  if (frame.kind !== "session.data") {
    throw new Error("Missing encrypted session request.");
  }
  return {
    request: remoteRequestSchema.parse(
      await openSessionData(session.recipient, frame),
    ),
  };
}

async function nextRequestOfType<T extends RemoteRequest["type"]>(
  session: SeededSession,
  type: T,
  shell: RemoteSafeShell,
  detail?: RemoteSafeConversationDetail,
): Promise<Extract<RemoteRequest, { type: T }>> {
  for (;;) {
    const request = await nextSessionRequest(session);
    if (request.type === type) {
      return request as Extract<RemoteRequest, { type: T }>;
    }
    if (request.type === "state.get") {
      await sendSessionResponse(session, request.requestId, {
        kind: "state",
        state: shell,
      });
      continue;
    }
    if (request.type === "conversation.get" && detail) {
      await sendSessionResponse(session, request.requestId, {
        kind: "conversation",
        detail,
      });
      continue;
    }
    throw new Error(`Unexpected remote request ${request.type}.`);
  }
}

async function sendSessionResponse(
  session: SeededSession,
  requestId: string,
  result: unknown,
): Promise<void> {
  desktop.send(JSON.stringify({
    relayProtocolVersion: RELAY_PROTOCOL_VERSION,
    type: "relay.frame",
    connectionId: session.connectionId,
    frame: await sealSessionData(session.sender, session.sessionId, {
      type: "response",
      requestId,
      ok: true,
      result,
    }),
  }));
}

async function nextDesktopMessage(
  accept: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return await nextSocketMessage(desktop, accept);
}

async function nextSocketMessage(
  socket: WebSocket,
  accept: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return await new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Desktop relay message timed out."));
    }, 15_000);
    const onMessage = (raw: WebSocket.RawData): void => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (!accept(message)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolveMessage(message);
    };
    socket.on("message", onMessage);
  });
}
