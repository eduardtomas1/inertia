import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { createOpencodeClient } from "@opencode-ai/sdk/v2";

import { confirmProviderProcessTermination } from "./provider-drift-process.mjs";

const [command, cwd, sentinel, mode] = process.argv.slice(2);
if (!command || !cwd || !sentinel || !["discover", "pure"].includes(mode)) {
  throw new Error("OpenCode runtime probe requires command, workspace, sentinel, and mode.");
}

const username = "provider-drift";
const password = "secret-free-placeholder";

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let startupOutput = "";
    let settled = false;
    const finish = (action) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stdout.off("data", onOutput);
      action();
    };
    const onError = (error) => finish(() => reject(error));
    const onExit = (code, signal) => finish(() => reject(new Error(
      `OpenCode runtime server exited during startup (${code ?? signal ?? "unknown"}).`,
    )));
    const onOutput = (chunk) => {
      startupOutput = `${startupOutput}${chunk.toString("utf8")}`.slice(-4_096);
      const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d{1,5})/u.exec(
        startupOutput,
      );
      if (match) finish(() => resolve(match[1]));
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error("OpenCode runtime server did not become ready."))),
      20_000,
    );
    timer.unref();
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdout.on("data", onOutput);
  });
}

async function waitForSentinel(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(sentinel)) return;
    await new Promise((settle) => setTimeout(settle, 50));
  }
  if (!existsSync(sentinel)) {
    throw new Error("OpenCode did not discover the project plugin sentinel.");
  }
}

async function requireSentinelAbsentFor(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(sentinel)) {
      throw new Error("OpenCode --pure executed an external project plugin.");
    }
    await new Promise((settle) => setTimeout(settle, 50));
  }
}

async function withServer(pure, operation) {
  const child = spawn(
    command,
    ["serve", ...(pure ? ["--pure"] : []), "--hostname=127.0.0.1", "--port=0"],
    {
      cwd,
      detached: false,
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
    await operation(await waitForServer(child));
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

const authorization = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;

if (mode === "discover") {
  await withServer(false, async (baseUrl) => {
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
    await waitForSentinel(5_000);
  });
  console.log("OpenCode project plugin semantic control passed.");
} else {
  if (existsSync(sentinel)) {
    throw new Error("OpenCode --pure sentinel was not isolated before launch.");
  }
  await withServer(true, async (baseUrl) => {
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
    await requireSentinelAbsentFor(5_000);
  });
  console.log("OpenCode --pure semantic isolation passed.");
}
