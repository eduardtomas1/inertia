import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";

import { createOpencodeClient } from "@opencode-ai/sdk/v2";

import { confirmProviderProcessTermination } from "./provider-drift-process.mjs";

const [command, cwd, sentinel] = process.argv.slice(2);
if (!command || !cwd || !sentinel) {
  throw new Error("OpenCode runtime probe requires command, workspace, and sentinel paths.");
}

const username = "provider-drift";
const password = "secret-free-placeholder";

async function withServer(pure, operation) {
  const child = spawn(
    command,
    ["serve", ...(pure ? ["--pure"] : []), "--hostname=127.0.0.1", "--port=0"],
    {
      cwd,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        OPENCODE_SERVER_USERNAME: username,
        OPENCODE_SERVER_PASSWORD: password,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stderr.resume();
  let probeError;
  let cleanupConfirmed = false;
  try {
    const baseUrl = await new Promise((resolve, reject) => {
      let startupOutput = "";
      const timer = setTimeout(
        () => reject(new Error("OpenCode runtime server did not become ready.")),
        20_000,
      );
      timer.unref();
      child.once("error", reject);
      child.once("exit", (code, signal) => reject(new Error(
        `OpenCode runtime server exited during startup (${code ?? signal ?? "unknown"}).`,
      )));
      child.stdout.on("data", (chunk) => {
        startupOutput = `${startupOutput}${chunk.toString("utf8")}`.slice(-4_096);
        const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d{1,5})/u.exec(
          startupOutput,
        );
        if (!match) return;
        clearTimeout(timer);
        resolve(match[1]);
      });
    });
    await operation(baseUrl);
  } catch (error) {
    probeError = error;
  } finally {
    cleanupConfirmed = await confirmProviderProcessTermination(child);
  }
  if (!cleanupConfirmed) {
    throw new AggregateError(
      probeError ? [probeError] : [],
      "OpenCode runtime server cleanup could not be confirmed.",
    );
  }
  if (probeError) throw probeError;
}

// Positive control: prove the isolated project plugin is discoverable before
// using its absence as evidence that --pure suppressed external code.
await withServer(false, async (baseUrl) => {
  const authorization = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
  const client = createOpencodeClient({
    baseUrl,
    directory: cwd,
    throwOnError: true,
    headers: { Authorization: authorization },
  });
  await client.global.health({ throwOnError: true });
  await client.provider.list(
    { directory: cwd },
    { throwOnError: true },
  );
  const discovered = await new Promise((resolve) => {
    const deadline = Date.now() + 5_000;
    const inspect = () => {
      if (existsSync(sentinel)) {
        resolve(true);
      } else if (Date.now() >= deadline) {
        resolve(false);
      } else {
        setTimeout(inspect, 50);
      }
    };
    inspect();
  });
  if (!discovered) throw new Error("OpenCode did not discover the project plugin sentinel.");
});
unlinkSync(sentinel);

await withServer(true, async (baseUrl) => {
  const authorization = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
  const client = createOpencodeClient({
    baseUrl,
    directory: cwd,
    throwOnError: true,
    headers: { Authorization: authorization },
  });
  const health = await client.global.health({ throwOnError: true });
  const providers = await client.provider.list(
    { directory: cwd },
    { throwOnError: true },
  );
  const agents = await client.app.agents(
    { directory: cwd },
    { throwOnError: true },
  );
  if (health.data?.healthy !== true
    || !Array.isArray(providers.data?.all)
    || !Array.isArray(agents.data)) {
    throw new Error("OpenCode SDK runtime handshake returned an incompatible payload.");
  }
  if (existsSync(sentinel)) {
    throw new Error("OpenCode --pure executed an external project plugin.");
  }
});

console.log("OpenCode plugin-free SDK runtime handshake is compatible.");
