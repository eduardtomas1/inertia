import { sameRemoteConversationGrants } from "../shared/remote-grants";
import type { RemoteConnectionEpoch } from "./remote-access-relay-dispatcher";
import { remoteDeviceIsCurrent } from "./remote-access-policy";
import type { ActiveRemoteSession } from "./remote-access-service-types";
import type { PersistedRemoteAccess } from "./remote-access-store";

export interface RemoteSessionAdmission {
  connectionId: string;
  connectionEpoch: RemoteConnectionEpoch;
  sessionId: string;
  deviceId?: string;
}

interface RemoteSessionAdmissionAuthority {
  capacity: number;
  authenticationCapacity: number;
  activeCount(): number;
  hasActiveSession(sessionId: string): boolean;
  hasUsedSession(sessionId: string): boolean;
  hasActiveConnection(connectionId: string): boolean;
  ownsConnection(
    connectionId: string,
    epoch: RemoteConnectionEpoch,
  ): boolean;
  takeAuthenticationAttempt(connectionId: string): boolean;
}

export class RemoteSessionAdmissions {
  private readonly bySession = new Map<string, RemoteSessionAdmission>();
  private readonly byConnection = new Map<string, RemoteSessionAdmission>();
  private readonly byDevice = new Map<string, Set<RemoteSessionAdmission>>();
  private readonly promoted = new Set<RemoteSessionAdmission>();
  private readonly blockedDevices = new Map<string, number>();

  constructor(private readonly authority: RemoteSessionAdmissionAuthority) {}

  reserve(
    connectionId: string,
    connectionEpoch: RemoteConnectionEpoch,
    sessionId: string,
  ): RemoteSessionAdmission | null {
    if (
      !this.authority.ownsConnection(connectionId, connectionEpoch)
      || this.bySession.size >= this.authority.authenticationCapacity
      || this.authority.hasActiveSession(sessionId)
      || this.bySession.has(sessionId)
      || this.authority.hasUsedSession(sessionId)
      || this.authority.hasActiveConnection(connectionId)
      || this.byConnection.has(connectionId)
      || !this.authority.takeAuthenticationAttempt(connectionId)
    ) return null;
    const admission = { connectionId, connectionEpoch, sessionId };
    this.bySession.set(sessionId, admission);
    this.byConnection.set(connectionId, admission);
    return admission;
  }

  owns(admission: RemoteSessionAdmission): boolean {
    return this.bySession.get(admission.sessionId) === admission
      && this.byConnection.get(admission.connectionId) === admission
      && this.authority.ownsConnection(
        admission.connectionId,
        admission.connectionEpoch,
      );
  }

  bindDevice(
    admission: RemoteSessionAdmission,
    deviceId: string,
  ): boolean {
    if (
      !this.owns(admission)
      || admission.deviceId !== undefined
      || this.isDeviceBlocked(deviceId)
    ) return false;
    admission.deviceId = deviceId;
    const admissions = this.byDevice.get(deviceId) ?? new Set();
    admissions.add(admission);
    this.byDevice.set(deviceId, admissions);
    return true;
  }

  promote(admission: RemoteSessionAdmission): boolean {
    if (
      !this.owns(admission)
      || this.promoted.has(admission)
      || this.authority.activeCount() + this.promoted.size
        >= this.authority.capacity
    ) return false;
    this.promoted.add(admission);
    return true;
  }

  release(admission: RemoteSessionAdmission): void {
    this.promoted.delete(admission);
    if (this.bySession.get(admission.sessionId) === admission) {
      this.bySession.delete(admission.sessionId);
    }
    if (this.byConnection.get(admission.connectionId) === admission) {
      this.byConnection.delete(admission.connectionId);
    }
    if (admission.deviceId !== undefined) {
      const admissions = this.byDevice.get(admission.deviceId);
      admissions?.delete(admission);
      if (admissions?.size === 0) this.byDevice.delete(admission.deviceId);
    }
  }

  drop(
    connectionId: string,
    epoch?: RemoteConnectionEpoch,
  ): void {
    const admission = this.byConnection.get(connectionId);
    if (
      admission
      && (epoch === undefined || admission.connectionEpoch === epoch)
    ) {
      this.release(admission);
    }
  }

  clear(): void {
    this.bySession.clear();
    this.byConnection.clear();
    this.byDevice.clear();
    this.promoted.clear();
  }

  dropDevice(deviceId: string): void {
    for (const admission of this.byDevice.get(deviceId) ?? []) {
      this.release(admission);
    }
  }

  blockDevice(deviceId: string): () => void {
    this.blockedDevices.set(
      deviceId,
      (this.blockedDevices.get(deviceId) ?? 0) + 1,
    );
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.blockedDevices.get(deviceId) ?? 1) - 1;
      if (remaining > 0) this.blockedDevices.set(deviceId, remaining);
      else this.blockedDevices.delete(deviceId);
    };
  }

  isDeviceBlocked(deviceId: string): boolean {
    return this.blockedDevices.has(deviceId);
  }
}

export interface RemoteSessionAuthorityInput {
  data: PersistedRemoteAccess | null;
  session: ActiveRemoteSession;
  live: boolean;
  ownsRoute: boolean;
  privacyLocked: boolean;
  stopped: boolean;
  storeFailed: boolean;
  now: number;
}

export function remoteSessionRetainsAuthority(
  input: RemoteSessionAuthorityInput,
): boolean {
  const { data, session } = input;
  return data !== null
    && data.enabled
    && input.live
    && input.ownsRoute
    && !input.privacyLocked
    && !input.stopped
    && !input.storeFailed
    && !session.outboundAbandoned
    && data.devices.find(({ id }) => id === session.device.id)
      === session.device
    && remoteDeviceIsCurrent(session.device, input.now)
    && session.subject.deviceId === session.device.id
    && session.subject.sessionId === session.sessionId
    && session.subject.grantVersion === session.device.grantVersion
    && session.subject.expiresAt === session.device.expiresAt
    && Date.parse(session.subject.expiresAt) > input.now
    && sameStrings(session.subject.scopes, session.device.scopes)
    && sameStrings(session.subject.projectIds, session.device.projectIds)
    && sameRemoteConversationGrants(
      session.subject.grants,
      session.device.grants,
    )
    && session.subject.scopes.includes("view");
}

export function remoteSessionCanCommitPrompt(
  input: RemoteSessionAuthorityInput,
): boolean {
  return remoteSessionRetainsAuthority(input)
    && input.session.subject.scopes.includes("prompt");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
