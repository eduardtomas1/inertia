import { once } from "node:events";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";

import WebSocket, { WebSocketServer } from "ws";

const CASES = [
  { label: "16 KB activity burst", targetBytes: 16 * 1024, iterations: 80 },
  { label: "128 KB detail sync", targetBytes: 128 * 1024, iterations: 24 },
  { label: "256 KB bounded snapshot", targetBytes: 256 * 1024, iterations: 12 },
];

function representativePayload(targetBytes) {
  let state = 0x5f3759df;
  const nextWord = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return [
      "provider",
      "workspace",
      "activity",
      "completed",
      "src/renderer/components",
      `segment-${Math.abs(state) % 997}`,
    ][Math.abs(state) % 6];
  };
  const events = [];
  while (JSON.stringify({ type: "server.snapshot", events }).length < targetBytes) {
    const index = events.length;
    events.push({
      id: `activity-${index}`,
      type: index % 5 === 0 ? "command" : "commentary",
      status: index % 7 === 0 ? "running" : "completed",
      createdAt: "2026-07-29T12:00:00.000Z",
      content: Array.from({ length: 18 }, nextWord).join(" "),
    });
  }
  return JSON.stringify({ type: "server.snapshot", events });
}

async function closeServer(server, webSockets, client) {
  if (client.readyState === WebSocket.OPEN) client.close();
  if (
    client.readyState !== WebSocket.CLOSED
    && client.readyState !== WebSocket.CLOSING
  ) client.terminate();
  await Promise.race([
    once(client, "close"),
    new Promise((resolve) => setTimeout(resolve, 250)),
  ]);
  await new Promise((resolve) => webSockets.close(resolve));
  await new Promise((resolve, reject) => server.close((error) => {
    if (error) reject(error);
    else resolve();
  }));
}

async function benchmarkCase(testCase, compressed) {
  const payload = representativePayload(testCase.targetBytes);
  const server = createServer();
  const compression = compressed
    ? {
        threshold: 1024,
        concurrencyLimit: 4,
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
      }
    : false;
  const webSockets = new WebSocketServer({
    server,
    perMessageDeflate: compression,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The loopback benchmark did not receive a TCP port.");
  }
  const connected = once(webSockets, "connection");
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`, {
    perMessageDeflate: compression,
  });
  await once(client, "open");
  const [peer] = await connected;
  const transport = peer._socket;
  if (!transport) throw new Error("The benchmark WebSocket has no TCP socket.");

  let received = 0;
  const complete = new Promise((resolve) => {
    client.on("message", () => {
      received += 1;
      if (received === testCase.iterations) resolve();
    });
  });
  const startBytes = transport.bytesWritten;
  const startCpu = process.cpuUsage();
  const startedAt = performance.now();
  for (let index = 0; index < testCase.iterations; index += 1) {
    await new Promise((resolve, reject) => {
      peer.send(payload, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  await complete;
  const elapsedMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(startCpu);
  const wireBytes = transport.bytesWritten - startBytes;
  await closeServer(server, webSockets, client);
  return {
    label: testCase.label,
    mode: compressed ? "deflate" : "plain",
    payloadBytes: Buffer.byteLength(payload) * testCase.iterations,
    wireBytes,
    elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1_000,
  };
}

const results = [];
for (const testCase of CASES) {
  results.push(await benchmarkCase(testCase, false));
  results.push(await benchmarkCase(testCase, true));
}

const rows = results.map((result) => ({
  case: result.label,
  mode: result.mode,
  "payload MB": (result.payloadBytes / 1024 / 1024).toFixed(2),
  "wire MB": (result.wireBytes / 1024 / 1024).toFixed(2),
  "wire %": `${(result.wireBytes / result.payloadBytes * 100).toFixed(1)}%`,
  "wall ms": result.elapsedMs.toFixed(1),
  "CPU ms": result.cpuMs.toFixed(1),
}));

console.table(rows);
console.log(
  [
    "This is a localhost transport benchmark, not a production-network test.",
    "Inertia keeps permessage-deflate disabled by default: loopback bandwidth",
    "is not scarce, while compression adds CPU, native buffers, and per-client",
    "memory. Re-run on all target OSes before reconsidering that invariant.",
  ].join(" "),
);
