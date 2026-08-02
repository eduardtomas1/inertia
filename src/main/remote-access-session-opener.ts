import type { RemoteImportedKeyPair } from "../shared/remote-crypto";
import {
  REMOTE_PROTOCOL_VERSION,
  remoteVersionSupportsConditionalProjections,
  type RemoteCipherFrame,
} from "../shared/remote-protocol";
import type { PersistedRemoteAccess } from "./remote-access-store";
import type { RemoteSessionAdmissions } from "./remote-access-session-admission";
import {
  authenticateRemoteSession,
  authenticateRemoteTombstoneSession,
  authenticatedRemoteRejectionIsCurrent,
  authenticatedRemoteSessionDecisionFrame,
  rememberRemoteSession,
} from "./remote-access-session-handshake";
import type { ActiveRemoteSession } from "./remote-access-service-types";
import type { RemoteConnectionEpoch } from "./remote-access-relay-dispatcher";

export async function openRemoteSession(input: {
  data: PersistedRemoteAccess;
  admissions: RemoteSessionAdmissions;
  connectionId: string;
  epoch: RemoteConnectionEpoch;
  frame: Extract<RemoteCipherFrame, { kind: "session.open" }>;
  hostKeys: RemoteImportedKeyPair;
  browserVersion: string;
  sessions: Map<string, ActiveRemoteSession>;
  sessionByConnection: Map<string, string>;
  now(): Date;
  persist(): Promise<void>;
  sendFrame(connectionId: string, frame: RemoteCipherFrame): void;
  audit(deviceId: string, detail: string): void;
  emit(): void;
}): Promise<void> {
  const admission = input.admissions.reserve(
    input.connectionId,
    input.epoch,
    input.frame.sessionId,
  );
  if (!admission) return;
  try {
    for (const device of input.data.devices) {
      if (input.admissions.isDeviceBlocked(device.id)) continue;
      const authenticated = await authenticateRemoteSession({
        data: input.data,
        device,
        frame: input.frame,
        hostKeys: input.hostKeys,
        now: input.now,
        current: () => input.admissions.owns(admission)
          && !input.admissions.isDeviceBlocked(device.id),
      });
      if (authenticated === "stale") return;
      if (!authenticated) continue;
      if (
        !input.data.devices.includes(device)
        || input.admissions.isDeviceBlocked(device.id)
        || authenticated.subject.grantVersion !== device.grantVersion
      ) return;
      if (!input.admissions.bindDevice(admission, device.id)) return;
      if (authenticated.disposition !== "accepted") {
        rememberRemoteSession(
          input.data,
          input.frame.sessionId,
          input.now().toISOString(),
        );
        await input.persist();
        if (!authenticatedRemoteRejectionIsCurrent({
          data: input.data,
          device,
          authenticated,
          now: input.now(),
          current: () => input.admissions.owns(admission)
            && !input.admissions.isDeviceBlocked(device.id),
        })) return;
        input.sendFrame(
          input.connectionId,
          authenticatedRemoteSessionDecisionFrame(
            input.frame.sessionId,
            authenticated,
          ),
        );
        return;
      }
      if (!input.admissions.promote(admission)) {
        input.sendFrame(input.connectionId, {
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          kind: "session.close",
          sessionId: input.frame.sessionId,
          reason: "rate-limited",
        });
        return;
      }
      const now = input.now().getTime();
      rememberRemoteSession(
        input.data,
        input.frame.sessionId,
        input.now().toISOString(),
      );
      const session: ActiveRemoteSession = {
        connectionId: input.connectionId,
        connectionEpoch: input.epoch,
        sessionId: input.frame.sessionId,
        device,
        recipient: authenticated.recipient,
        sender: authenticated.sender,
        subject: authenticated.subject,
        supportsAuthenticatedRejection:
          authenticated.supportsAuthenticatedRejection,
        supportsConditionalProjections:
          remoteVersionSupportsConditionalProjections(input.browserVersion),
        createdAt: now,
        lastActivityAt: now,
        requestTimes: [],
        promptTimes: [],
        inFlight: new Map(),
        postedPromptDeliveries: new Set(),
        outboundTail: Promise.resolve(),
        outboundAbandoned: false,
      };
      device.lastSeenAt = input.now().toISOString();
      input.audit(device.id, "A remote session connected.");
      await input.persist();
      if (
        !input.admissions.owns(admission)
        || input.admissions.isDeviceBlocked(device.id)
      ) return;
      input.sessions.set(input.frame.sessionId, session);
      input.sessionByConnection.set(input.connectionId, input.frame.sessionId);
      input.sendFrame(input.connectionId, {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        kind: "session.accept",
        sessionId: input.frame.sessionId,
        enc: authenticated.sender.enc,
        ciphertext: authenticated.ciphertext,
      });
      input.emit();
      return;
    }
    await rejectTombstonedSession(input, admission);
  } finally {
    input.admissions.release(admission);
  }
}

async function rejectTombstonedSession(
  input: Parameters<typeof openRemoteSession>[0],
  admission: NonNullable<ReturnType<RemoteSessionAdmissions["reserve"]>>,
): Promise<void> {
  for (const tombstone of input.data.deviceTombstones ?? []) {
    if (
      Date.parse(tombstone.retainUntil) <= input.now().getTime()
      || input.admissions.isDeviceBlocked(tombstone.deviceId)
    ) continue;
    const authenticated = await authenticateRemoteTombstoneSession({
      data: input.data,
      tombstone,
      frame: input.frame,
      hostKeys: input.hostKeys,
      now: input.now,
      current: () => input.admissions.owns(admission)
        && (input.data.deviceTombstones ?? []).includes(tombstone)
        && !input.admissions.isDeviceBlocked(tombstone.deviceId),
    });
    if (authenticated === "stale") return;
    if (!authenticated) continue;
    if (!input.admissions.bindDevice(admission, tombstone.deviceId)) return;
    rememberRemoteSession(
      input.data,
      input.frame.sessionId,
      input.now().toISOString(),
    );
    await input.persist();
    if (
      !input.admissions.owns(admission)
      || !(input.data.deviceTombstones ?? []).includes(tombstone)
    ) return;
    input.sendFrame(input.connectionId, authenticated.supportsAuthenticatedRejection
      ? {
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          kind: "session.accept",
          sessionId: input.frame.sessionId,
          enc: authenticated.sender.enc,
          ciphertext: authenticated.ciphertext,
        }
      : {
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          kind: "session.close",
          sessionId: input.frame.sessionId,
          reason: "shutdown",
        });
    return;
  }
}
