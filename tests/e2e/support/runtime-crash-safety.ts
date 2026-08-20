import { expect, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

import { readSystemBootId } from "../../../src/main/system-boot-id";
import { RuntimeGenerationLeaseJournal } from "../../../src/node/runtime-generation-leases";
import {
  readLinuxProcessIdentity,
  RuntimeOwnedProcessJournal,
} from "../../../src/node/runtime-owned-processes";
import {
  processExists,
  type AppFixture,
  type RuntimeTestSnapshot,
} from "./app-fixture";
import {
  ensureWorkspaceTools,
  selectWorkspaceTool,
} from "./workspace-tools";

interface RuntimeObservation {
  readonly observedAt: string;
  readonly generation: number;
  readonly phase: string;
  readonly pid: number | null;
}

function runtimeObservation(snapshot: RuntimeTestSnapshot): RuntimeObservation {
  return {
    observedAt: new Date().toISOString(),
    generation: snapshot.generation,
    phase: snapshot.phase,
    pid: snapshot.pid,
  };
}

function procState(pid: number): { state: string | null; errorCode: string | null } {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closingName = stat.lastIndexOf(")");
    const state = closingName >= 2
      ? stat.slice(closingName + 1).trimStart()[0] ?? null
      : null;
    return state && /^[A-Za-z]$/u.test(state)
      ? { state, errorCode: null }
      : { state: null, errorCode: "INVALID" };
  } catch (error) {
    return {
      state: null,
      errorCode: error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "UNKNOWN",
    };
  }
}

export async function expectRuntimeCrashRecovery(
  app: AppFixture,
  testInfo?: TestInfo,
): Promise<void> {
  const { electronApp, page, runtimeSnapshot, testDirectory } = app;
  await expect.poll(
    async () => (await runtimeSnapshot()).phase,
    { timeout: 15_000 },
  ).toBe("ready");
  const before = await runtimeSnapshot();
  const beforeObservation = runtimeObservation(before);
  const dataDirectory = join(testDirectory, "data");
  const priorLease = process.platform === "linux"
    ? new RuntimeGenerationLeaseJournal(dataDirectory).all().find((lease) =>
      lease.runtimeGenerationId.endsWith(`:${before.generation}`)) ?? null
    : null;
  const beforeUrl = await page.evaluate(() =>
    window.inertia.getRuntimeConnection().then(({ websocketUrl }) => websocketUrl));
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-runtime-generation",
    /^[0-9a-f-]{36}$/iu,
  );
  const beforeRuntimeGeneration = await page.locator(".app-shell")
    .getAttribute("data-runtime-generation");
  expect(beforeRuntimeGeneration).toMatch(/^[0-9a-f-]{36}$/iu);
  const tools = await ensureWorkspaceTools(page);
  await selectWorkspaceTool(tools, "Terminal");
  const terminal = page.locator("aside.terminal-panel").first();
  const restartTerminal = terminal.getByRole("button", { name: "Start again" });
  let retriedTerminalAdmission = false;
  await expect.poll(async () => {
    if (await terminal.getAttribute("data-terminal-id")) return true;
    if (
      !retriedTerminalAdmission
      && await restartTerminal.isVisible().catch(() => false)
    ) {
      retriedTerminalAdmission = true;
      await restartTerminal.click();
    }
    return false;
  }, { timeout: 5_000 }).toBe(true);
  await expect(terminal).toHaveAttribute("data-terminal-id", /.+/u);
  const beforeTerminalId = await terminal.getAttribute("data-terminal-id");
  expect(beforeTerminalId).toBeTruthy();
  let recoveryRootPid: number | null = null;
  if (process.platform === "linux") {
    // Keep the exact claimed terminal root alive after the utility process is
    // killed. An ordinary interactive shell exits when its PTY owner dies,
    // which intentionally exercises the separate missing-root fail-closed
    // boundary instead of the positive exact-identity recovery path below.
    // Encode the marker embedded in the command so terminal echo cannot make
    // the readiness assertion pass before exec installs the SIGHUP handler.
    const recoveryRootReadyMarker = "INERTIA_RECOVERY_ROOT_READY:";
    const encodedReadyMarker = Buffer.from(
      recoveryRootReadyMarker,
      "utf8",
    ).toString("base64");
    const recoveryRootSource = [
      "process.on('SIGHUP', () => undefined);",
      `process.stdout.write(Buffer.from(${JSON.stringify(encodedReadyMarker)},'base64')+String(process.pid)+'\\n');`,
      "setInterval(() => undefined, 1000);",
    ].join("");
    const terminalInput = terminal.locator(".xterm-helper-textarea");
    await terminalInput.focus();
    await page.keyboard.insertText(
      `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(recoveryRootSource)}`,
    );
    await page.keyboard.press("Enter");
    await expect.poll(async () => {
      const match = (await terminal.textContent())?.match(
        /INERTIA_RECOVERY_ROOT_READY:([0-9]+)/u,
      );
      const pid = Number(match?.[1] ?? 0);
      recoveryRootPid = Number.isSafeInteger(pid) && pid > 1 ? pid : null;
      return recoveryRootPid;
    }).not.toBeNull();
  }
  const database = new Database(join(testDirectory, "data", "inertia.sqlite"));
  const conversation = database.prepare(`
    SELECT conversations.id
    FROM conversations
    JOIN app_state ON app_state.active_conversation_id = conversations.id
    WHERE app_state.id = 1
  `).get() as { id: string };
  const conversationCount = (database.prepare(
    "SELECT COUNT(*) AS count FROM conversations",
  ).get() as { count: number }).count;
  database.prepare("UPDATE conversations SET status = 'running' WHERE id = ?")
    .run(conversation.id);
  database.prepare("INSERT INTO messages (id, conversation_id, role, content, attachments_json, created_at) VALUES (?, ?, 'assistant', ?, '[]', ?)")
    .run(
      randomUUID(),
      conversation.id,
      "# Timeline response\n\n```ts file=src/timeline.ts\nconst ready: boolean = true;\n```\n\n| Check | State |\n| --- | --- |\n| Renderer | ready |\n\n<script>window.__unsafeMarkdown = true</script>",
      new Date(Date.now() - 1_000).toISOString(),
    );
  database.prepare("INSERT INTO activities (id, conversation_id, run_id, kind, title, detail, status, created_at) VALUES (?, ?, ?, 'command', 'Interrupted E2E command', NULL, 'running', ?)")
    .run(randomUUID(), conversation.id, "e2e-interrupted-run", new Date().toISOString());
  database.close();
  await page.evaluate(() => {
    Reflect.set(window, "__inertiaNoReloadMarker", crypto.randomUUID());
  });
  const marker = await page.evaluate(() =>
    Reflect.get(window, "__inertiaNoReloadMarker") as string);

  if (process.platform === "linux") {
    expect(priorLease).not.toBeNull();
    expect(recoveryRootPid).not.toBeNull();
    const journal = new RuntimeOwnedProcessJournal(dataDirectory);
    let stableSince: number | null = null;
    let stableSignature: string | null = null;
    let latestDiagnostic: unknown = null;
    const quiescenceStartedAt = Date.now();
    const observedClaims = new Map<string, {
      firstSeenMs: number;
      lastSeenMs: number;
      samples: number;
      states: Set<"owned" | "pending">;
    }>();
    try {
      await expect.poll(() => {
        const records = journal.records(priorLease!.runtimeGenerationId);
        const systemBootId = readSystemBootId();
        let allExact = Boolean(records?.length);
        let intendedRootIncluded = false;
        const claims = (records ?? []).map((record) => {
          const observedAtMs = Date.now() - quiescenceStartedAt;
          const observation = observedClaims.get(record.ownershipId) ?? {
            firstSeenMs: observedAtMs,
            lastSeenMs: observedAtMs,
            samples: 0,
            states: new Set<"owned" | "pending">(),
          };
          observation.lastSeenMs = observedAtMs;
          observation.samples += 1;
          observation.states.add(record.state);
          observedClaims.set(record.ownershipId, observation);
          if (record.state === "pending") {
            allExact = false;
            return {
              state: record.state,
              ownershipId: record.ownershipId,
              bootMatch: record.systemBootId === systemBootId,
              process: null,
              currentIdentity: null,
              currentIdentityErrorCode: null,
              proc: null,
            };
          }
          let currentIdentity = null;
          let currentIdentityErrorCode: string | null = null;
          try {
            currentIdentity = readLinuxProcessIdentity(record.process.pid);
          } catch (error) {
            currentIdentityErrorCode = error
              && typeof error === "object"
              && "code" in error
              ? String(error.code)
              : "UNKNOWN";
          }
          const exact = Boolean(
            currentIdentity
            && RuntimeOwnedProcessJournal.identityMatches(record, currentIdentity),
          );
          allExact &&= exact && record.systemBootId === systemBootId;
          intendedRootIncluded ||= exact
            && record.process.pid === recoveryRootPid;
          return {
            state: record.state,
            ownershipId: record.ownershipId,
            bootMatch: record.systemBootId === systemBootId,
            process: record.process,
            currentIdentity,
            currentIdentityErrorCode,
            proc: procState(record.process.pid),
          };
        });
        latestDiagnostic = {
          priorGenerationId: priorLease!.runtimeGenerationId,
          intendedRootPid: recoveryRootPid,
          recordsReadable: records !== null,
          claims,
          observedClaims: [...observedClaims.entries()].map(
            ([ownershipId, observation]) => ({
              ownershipId,
              firstSeenMs: observation.firstSeenMs,
              lastSeenMs: observation.lastSeenMs,
              samples: observation.samples,
              states: [...observation.states].sort(),
            }),
          ),
        };
        if (!allExact || !intendedRootIncluded || !records) {
          stableSince = null;
          stableSignature = null;
          return false;
        }
        const signature = JSON.stringify([...records].sort((left, right) =>
          left.ownershipId.localeCompare(right.ownershipId)));
        if (signature !== stableSignature) {
          stableSignature = signature;
          stableSince = Date.now();
          return false;
        }
        return stableSince !== null && Date.now() - stableSince >= 250;
      }, { timeout: 5_000, intervals: [25] }).toBe(true);
    } catch (error) {
      if (testInfo) {
        await testInfo.attach("runtime-owned-process-pre-crash-diagnostic", {
          body: Buffer.from(JSON.stringify(latestDiagnostic, null, 2), "utf8"),
          contentType: "application/json",
        });
      }
      throw error;
    }
  }

  const crashed = await electronApp.evaluate((_electron) => {
    const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
      crash: () => RuntimeTestSnapshot;
    } | undefined;
    if (!runtime) throw new Error("The test runtime supervisor is unavailable");
    return runtime.crash();
  });
  const crashReturnedObservation = runtimeObservation(crashed);
  expect(crashed.pid).toBe(before.pid);

  await expect.poll(async () => {
    const current = await runtimeSnapshot();
    return current.phase === "ready" && current.generation > before.generation;
  }, { timeout: 10_000 }).toBe(true);
  const after = await runtimeSnapshot();
  const replacementReadyObservation = runtimeObservation(after);
  const afterUrl = await page.evaluate(() =>
    window.inertia.getRuntimeConnection().then(({ websocketUrl }) => websocketUrl));
  expect(after.generation).toBeGreaterThan(before.generation);
  expect(after.pid).not.toBe(before.pid);
  expect(afterUrl).not.toBe(beforeUrl);
  await expect.poll(() => page.locator(".app-shell")
    .getAttribute("data-runtime-generation")).not.toBe(beforeRuntimeGeneration);
  expect(await page.evaluate(() =>
    Reflect.get(window, "__inertiaNoReloadMarker"))).toBe(marker);
  await expect(page.getByRole("heading", { name: "New chat", level: 1 })).toBeVisible();
  const newChat = page.getByRole("button", { name: "New chat" }).first();
  const interruptedNotice = page.getByText(
    "The previous run ended when Inertia closed. Send another message to continue.",
  );
  await expect(page.getByRole("heading", { name: "Timeline response", level: 1 }))
    .toBeVisible();
  await expect(page.getByRole("button", { name: "Copy" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Markdown" })).toBeVisible();
  expect(await page.evaluate(() =>
    Reflect.get(window, "__unsafeMarkdown"))).toBeUndefined();
  const safetyAlert = page.locator(".error-toast[role=\"alert\"]");
  if (process.platform !== "linux") {
    await expect(interruptedNotice).toHaveCount(0);
    await expect(safetyAlert).toContainText(
      "Changes are unavailable in recovery safety mode.",
    );
    await expect(terminal).not.toHaveAttribute("data-terminal-id", /.+/u);
    await safetyAlert.getByRole("button", { name: "Dismiss error" }).click();
    await expect(safetyAlert).toHaveCount(0);
    await newChat.click();
    await expect(safetyAlert).toContainText(
      "Changes are unavailable in recovery safety mode.",
    );
    const preserved = new Database(join(testDirectory, "data", "inertia.sqlite"), {
      readonly: true,
    });
    try {
      expect((preserved.prepare("SELECT COUNT(*) AS count FROM conversations")
        .get() as { count: number }).count).toBe(conversationCount);
      expect(preserved.prepare("SELECT status FROM conversations WHERE id = ?")
        .get(conversation.id)).toEqual({ status: "running" });
      expect(preserved.prepare("SELECT status FROM activities WHERE run_id = ?")
        .get("e2e-interrupted-run")).toEqual({ status: "running" });
    } finally {
      preserved.close();
    }
    if (before.pid) {
      await expect.poll(() => processExists(before.pid as number), {
        timeout: 5_000,
      }).toBe(false);
    }
    return;
  }
  await expect(newChat).toBeEnabled();
  if (
    testInfo
    && priorLease
    && await safetyAlert.isVisible().catch(() => false)
  ) {
    const systemBootId = readSystemBootId();
    const records = new RuntimeOwnedProcessJournal(dataDirectory)
      .records(priorLease.runtimeGenerationId);
    const claims = (records ?? []).map((record) => {
      if (record.state === "pending") {
        return {
          state: record.state,
          ownershipId: record.ownershipId,
          bootMatch: record.systemBootId === systemBootId,
          process: null,
          currentIdentity: null,
          currentIdentityErrorCode: null,
          proc: null,
        };
      }
      let currentIdentity = null;
      let currentIdentityErrorCode: string | null = null;
      try {
        currentIdentity = readLinuxProcessIdentity(record.process.pid);
      } catch (error) {
        currentIdentityErrorCode = error
          && typeof error === "object"
          && "code" in error
          ? String(error.code)
          : "UNKNOWN";
      }
      return {
        state: record.state,
        ownershipId: record.ownershipId,
        bootMatch: record.systemBootId === systemBootId,
        process: record.process,
        currentIdentity,
        currentIdentityErrorCode,
        proc: procState(record.process.pid),
      };
    });
    await testInfo.attach("runtime-owned-process-recovery-diagnostic", {
      body: Buffer.from(JSON.stringify({
        priorGenerationId: priorLease.runtimeGenerationId,
        observations: {
          before: beforeObservation,
          crashReturned: crashReturnedObservation,
          replacementReady: replacementReadyObservation,
        },
        recordsReadable: records !== null,
        claims,
      }, null, 2), "utf8"),
      contentType: "application/json",
    });
  }
  await expect(interruptedNotice).toBeVisible();
  await expect(terminal).toHaveAttribute("data-terminal-id", /.+/u);
  await expect.poll(() => terminal.getAttribute("data-terminal-id"))
    .not.toBe(beforeTerminalId);
  await expect(terminal.locator(".terminal-overlay[role=\"status\"]"))
    .toHaveCount(0);
  await expect(safetyAlert).toHaveCount(0);
  await newChat.click();
  await expect.poll(() => {
    const current = new Database(join(testDirectory, "data", "inertia.sqlite"), {
      readonly: true,
    });
    try {
      return (current.prepare("SELECT COUNT(*) AS count FROM conversations")
        .get() as { count: number }).count;
    } finally {
      current.close();
    }
  }).toBe(conversationCount + 1);
  await expect(safetyAlert).toHaveCount(0);
  const preserved = new Database(join(testDirectory, "data", "inertia.sqlite"), {
    readonly: true,
  });
  try {
    expect(preserved.prepare("SELECT status FROM conversations WHERE id = ?")
      .get(conversation.id)).toEqual({ status: "failed" });
    expect(preserved.prepare("SELECT status FROM activities WHERE run_id = ?")
      .get("e2e-interrupted-run")).toEqual({ status: "failed" });
    expect((preserved.prepare("SELECT COUNT(*) AS count FROM conversations")
      .get() as { count: number }).count).toBe(conversationCount + 1);
  } finally {
    preserved.close();
  }
  if (before.pid) {
    await expect.poll(() => processExists(before.pid as number), {
      timeout: 5_000,
    }).toBe(false);
  }
}
