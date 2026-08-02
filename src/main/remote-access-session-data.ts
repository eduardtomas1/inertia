import { openSessionData } from "../shared/remote-crypto";
import {
  REMOTE_LIMITS,
  remoteRequestSchema,
  type RemoteCipherFrame,
  type RemoteRequest,
  type RemoteResponse,
} from "../shared/remote-protocol";
import { remoteDeviceIsCurrent, takeRemoteRate } from "./remote-access-policy";
import type { RemoteConnectionEpoch } from "./remote-access-relay-dispatcher";
import type { ActiveRemoteSession } from "./remote-access-service-types";

export async function handleRemoteSessionData(input: {
  sessions: Map<string, ActiveRemoteSession>;
  connectionId: string;
  epoch: RemoteConnectionEpoch;
  frame: Extract<RemoteCipherFrame, { kind: "session.data" }>;
  now(): Date;
  owns(connectionId: string, epoch: RemoteConnectionEpoch): boolean;
  close(session: ActiveRemoteSession, reason: "expired" | "rate-limited" | "replay"): void;
  respond(session: ActiveRemoteSession, response: RemoteResponse): Promise<void>;
  dispatch(session: ActiveRemoteSession, request: RemoteRequest): Promise<void>;
  drop(session: ActiveRemoteSession): void;
}): Promise<void> {
  const session = input.sessions.get(input.frame.sessionId);
  if (
    !session
    || session.connectionId !== input.connectionId
    || session.connectionEpoch !== input.epoch
  ) return;
  if (!remoteDeviceIsCurrent(session.device, input.now().getTime())) {
    input.close(session, "expired");
    return;
  }
  if (!takeRemoteRate(
    session.requestTimes,
    REMOTE_LIMITS.requestsPerMinute,
    input.now().getTime(),
  )) {
    input.close(session, "rate-limited");
    return;
  }
  let request: RemoteRequest;
  try {
    request = remoteRequestSchema.parse(
      await openSessionData(session.recipient, input.frame),
    );
  } catch {
    input.close(session, "replay");
    return;
  }
  if (!input.owns(input.connectionId, input.epoch)) return;
  session.lastActivityAt = input.now().getTime();
  if (
    request.type === "prompt.send"
    && !takeRemoteRate(
      session.promptTimes,
      REMOTE_LIMITS.promptRequestsPerMinute,
      input.now().getTime(),
    )
  ) {
    await input.respond(session, {
      type: "response",
      requestId: request.requestId,
      ok: false,
      code: "rate-limited",
      message: "Remote prompting is temporarily rate limited.",
    });
    return;
  }
  if (
    session.inFlight.size >= REMOTE_LIMITS.inFlightRequestsPerSession
    || session.inFlight.has(request.requestId)
  ) {
    await input.respond(session, {
      type: "response",
      requestId: request.requestId,
      ok: false,
      code: "busy",
      message: "Too many remote requests are active.",
    });
    return;
  }
  session.inFlight.set(request.requestId, request);
  void input.dispatch(session, request).catch(() => input.drop(session));
}
