# Local WebSocket compression

Inertia deliberately keeps `permessage-deflate` disabled on its authenticated
loopback WebSocket. The transport never crosses the public network, so reducing
wire bytes does not automatically improve user-visible latency. Compression
also adds CPU work, native zlib state, and per-client memory.

Run the checked-in benchmark with Node 22:

```sh
npm run benchmark:websocket-compression
```

It sends representative activity, detail-sync, and maximum-sized client
snapshot payloads through real `ws` server/client pairs on `127.0.0.1`. It
reports application bytes, TCP bytes, elapsed time, and process CPU for plain
and compressed transport. Connection setup is excluded.

The benchmark is evidence for a decision, not a CI gate. Compression should
only be enabled after repeated macOS, Windows, and Linux runs demonstrate a
user-visible latency or memory benefit under concurrent clients. Large
snapshots should first be reduced structurally; loopback compression must not
be used to hide unbounded protocol growth.
