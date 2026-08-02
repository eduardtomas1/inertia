import { once } from "node:events";

import { WebSocket } from "ws";

import {
  generateRemoteEndpointKeyPair,
  signRemoteEndpointChallenge,
  type RemoteEndpointKeyPair,
} from "../../../src/main/remote-access-endpoint-auth";
import {
  RELAY_PROTOCOL_VERSION,
  REMOTE_DESKTOP_COMPATIBILITY,
  relayServerMessageSchema,
} from "../../../src/shared/remote-protocol";

export async function registerRelayDesktop(
  endpointId: string,
  url: string,
  existing?: RemoteEndpointKeyPair,
): Promise<{
  socket: WebSocket;
  endpointKeyPair: RemoteEndpointKeyPair;
  relayIdentity: string;
}> {
  const socket = new WebSocket(url);
  const helloPromise = nextRelayMessage(socket);
  await once(socket, "open");
  const hello = relayServerMessageSchema.parse(await helloPromise);
  if (hello.type !== "relay.hello") throw new Error("Missing relay hello.");
  const endpointKeyPair = existing ?? generateRemoteEndpointKeyPair();
  socket.send(JSON.stringify(existing ? {
    relayProtocolVersion: RELAY_PROTOCOL_VERSION,
    type: "relay.register.begin",
    endpointId,
    desktop: REMOTE_DESKTOP_COMPATIBILITY,
  } : {
    relayProtocolVersion: RELAY_PROTOCOL_VERSION,
    type: "relay.claim.begin",
    endpointId,
    endpointPublicKey: endpointKeyPair.publicKey,
    desktop: REMOTE_DESKTOP_COMPATIBILITY,
  }));
  const challenge = relayServerMessageSchema.parse(
    await nextRelayMessage(socket),
  );
  if (challenge.type !== "relay.register.challenge") {
    throw new Error("Missing relay endpoint challenge.");
  }
  socket.send(JSON.stringify(signRemoteEndpointChallenge(
    {
      purpose: challenge.purpose,
      relayIdentity: challenge.relayIdentity,
      endpointId: challenge.endpointId,
      endpointPublicKey: challenge.endpointPublicKey,
      nonce: challenge.nonce,
      epoch: challenge.epoch,
      expiresAt: challenge.expiresAt,
    },
    endpointKeyPair,
  )));
  const registered = relayServerMessageSchema.parse(
    await nextRelayMessage(socket),
  );
  if (registered.type !== "relay.registered") {
    throw new Error("Relay desktop registration failed.");
  }
  return { socket, endpointKeyPair, relayIdentity: hello.relayIdentity };
}

function nextRelayMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      socket.off("message", onMessage);
      reject(error);
    };
    const onMessage = (raw: WebSocket.RawData): void => {
      socket.off("error", onError);
      resolve(JSON.parse(raw.toString()) as unknown);
    };
    socket.once("error", onError);
    socket.once("message", onMessage);
  });
}
