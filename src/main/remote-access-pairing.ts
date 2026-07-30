import { randomUUID } from "node:crypto";

import { remoteRandomSecret } from "../shared/remote-crypto";
import {
  REMOTE_LIMITS,
  REMOTE_PROTOCOL_VERSION,
  type RemotePairingInvitation,
} from "../shared/remote-protocol";
import { sanitizeRemoteLabel } from "../shared/remote-sanitizer";
import type { PersistedRemoteAccess } from "./remote-access-store";

export function createRemotePairingInvitation(
  data: PersistedRemoteAccess,
  now: Date,
): RemotePairingInvitation {
  return {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    relayUrl: data.relayUrl,
    endpointId: data.endpointId,
    hostId: data.hostId,
    hostPublicKey: data.keyPair.publicKey,
    invitationId: randomUUID(),
    pairingSecret: remoteRandomSecret(),
    expiresAt: new Date(
      now.getTime() + REMOTE_LIMITS.pairingTtlMs,
    ).toISOString(),
  };
}

export function sanitizeRemoteDeviceLabel(label: string): string | null {
  return sanitizeRemoteLabel(label, 80);
}
