# Relay endpoint authentication

## Status

Design only. Not implemented in this pass. The existing flow is unchanged and
not weakened.

## Confirmed problem

`remote/relay/server.mjs` accepts the first socket that claims an endpoint ID:

```js
if (state.role !== "unregistered" || desktops.has(message.endpointId)) {
  sendError(socket, "capacity");
  return;
}
state.role = "desktop";
state.endpointId = message.endpointId;
desktops.set(message.endpointId, socket);
```

Possession of the endpoint ID is therefore the only requirement to occupy it.
An attacker who learns an endpoint ID — it travels in the pairing invitation and
in every browser `relay.connect` — can register it first and hold it. The
legitimate desktop then receives `capacity` and cannot serve its own devices.

This is an **availability** problem only. The attacker cannot read application
content: frames are HPKE-sealed to the device and host keys, and the relay never
holds session keys. A squatter also cannot impersonate the desktop to a browser,
because the browser authenticates the session handshake against the host public
key pinned at pairing.

Severity is bounded by the relay being a reference/self-hosted component and by
the desktop reconnecting, but a persistent squatter is a persistent outage.

## Design

### Endpoint host key

The desktop already owns an HPKE host key pair in the encrypted vault. Derive a
separate registration key from it rather than reusing it, so relay
authentication cannot be confused with application cryptography:

```
endpointHostKey = HKDF(hostPrivateKey, info = "inertia-relay/1/endpoint-host-key")
```

The endpoint ID stays what it is today — an opaque routing token. Registration
additionally proves possession of `endpointHostKey`.

The relay must learn the *public* half out of band, at endpoint creation:
`relay.claim` registers `endpointId -> endpointPublicKey` the first time an
endpoint is used, and the relay stores that binding durably. First claim wins,
which moves the trust decision from "who connects first each time" to "who
created the endpoint", and an attacker who never held the endpoint can never
produce a proof for it.

### Registration handshake

1. Desktop opens the socket and sends `relay.register.begin { endpointId }`.
2. Relay replies `relay.register.challenge { nonce, epoch, expiresAt }` where
   `nonce` is 32 random bytes, `expiresAt` is short (5 s), and `epoch` is a
   monotonically increasing counter for this endpoint.
3. Desktop replies `relay.register.proof { endpointId, epoch, nonce, signature }`
   with

   ```
   signature = Sign(endpointHostKey,
     "inertia-relay/1/register" || endpointId || nonce || epoch || relayIdentity)
   ```

4. Relay verifies the signature against the stored public key, that the nonce is
   the one it issued on this socket, that it has not been consumed, and that it
   has not expired. Only then does it bind the socket to the endpoint.

Signing the relay identity binds the proof to one relay so it cannot be replayed
against a different deployment. Signing the epoch prevents replay of an older
proof after a reconnect.

### Epochs and reconnection

Each successful registration increments the endpoint epoch. The relay keeps the
current epoch per endpoint and:

- accepts a proof only for the epoch it just issued;
- on a successful registration at epoch *n*, closes any socket still bound at an
  epoch < *n* and refuses further frames from it;
- tags every routed frame with the registering epoch so a stale desktop socket
  that wakes up cannot inject frames into a replacement session.

This makes legitimate reconnection safe — the returning desktop proves
possession again and takes over — while a stale or duplicated connection loses.

### Rate limiting

Failed proofs are the attack surface for guessing and for CPU exhaustion:

- per-IP: 5 failed registration attempts per minute, then a 60 s block;
- per-endpoint: 10 failed attempts per minute regardless of source;
- one outstanding challenge per socket, and a socket that fails a proof is closed
  rather than allowed to retry on the same connection;
- signature verification happens only after the nonce and rate checks, so an
  attacker cannot force asymmetric work by spraying proofs.

### Relay blindness

Nothing in this design gives the relay application plaintext or session keys. It
learns one additional public key per endpoint and a per-endpoint epoch counter.
It still cannot decrypt frames, mint sessions, or impersonate the desktop to a
paired browser.

### Protocol version compatibility

Registration authentication is a relay-transport change, not an application
change, so it moves independently of `REMOTE_PROTOCOL_VERSION`. Introduce
`relayProtocolVersion: 2` in the register messages:

- a v2 relay accepts a v1 `relay.register` only while a documented migration flag
  is on, and logs it as unauthenticated;
- a v2 desktop against a v1 relay detects the missing challenge and either falls
  back with a visible "this relay does not authenticate endpoints" warning, or
  refuses, depending on a user setting that defaults to warn for the reference
  relay and refuse for anything else;
- the flag and the v1 path are removed one release after v2 ships.

## Preparatory work that does not weaken the current flow

None was added to the relay in this pass, deliberately: adding a partial
challenge/proof path would create a second code path to keep correct without
delivering the guarantee. The prerequisites are already present — the desktop has
a durable host key pair in the encrypted vault, and
`RemoteRelayDispatcher` already tracks a `RemoteConnectionEpoch` per connection,
which the epoch rules above extend rather than replace.

## Required tests when implemented

- an attacker that registers a known endpoint ID with no host proof is refused,
  and the legitimate desktop still registers;
- replaying a previously valid proof (same nonce, or same signature at an older
  epoch) is refused;
- a legitimate reconnect succeeds and increments the epoch;
- two competing connections resolve to exactly one owner, and the loser is
  closed;
- the endpoint binding and epoch survive a relay restart, or the relay refuses to
  serve endpoints whose binding it lost;
- a delayed registration frame arriving after its challenge expired is refused;
- a stale connection that attempts to send frames after being replaced is
  refused and does not disturb the surviving session;
- failed-proof rate limits engage per IP and per endpoint, and verification is
  not reached before those checks.
