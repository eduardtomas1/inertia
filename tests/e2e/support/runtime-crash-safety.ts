import { expect, type TestInfo } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import Database from "better-sqlite3";

import { readSystemBootId } from "../../../src/main/system-boot-id";
import { RuntimeCleanupReceiptJournal } from
  "../../../src/main/runtime-cleanup-receipts";
import {
  listDirectRuntimeJournalLeaves,
  pinDirectRuntimeJournalRoot,
} from "../../../src/node/direct-runtime-journal";
import { RuntimeGenerationLeaseJournal } from "../../../src/node/runtime-generation-leases";
import { ModernDarwinRecoveryAuthorityJournal } from
  "../../../src/node/runtime-modern-recovery-authorities";
import {
  type ObservedRuntimeOwnedProcessIdentity,
  readDarwinProcessIdentity,
  readLinuxProcessIdentity,
  RuntimeOwnedProcessJournal,
} from "../../../src/node/runtime-owned-processes";
import type { AppFixture, RuntimeTestSnapshot } from "./app-fixture";
import {
  processExists,
  settleOperationBounded,
} from "./electron-app-lifecycle";
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

const RUNTIME_RECOVERY_DIALOG_RESTORE_TIMEOUT_MS = 5_000;

interface RuntimeRecoveryPromptObservation {
  readonly generation: number | null;
  readonly phase: string | null;
  readonly lastError: string | null;
}

interface RuntimeRecoveryErrorObservation {
  readonly title: string;
  readonly content: string;
}

export interface RuntimeRecoveryConsentDiagnostic {
  readonly promptCount: number;
  readonly prompts: readonly RuntimeRecoveryPromptObservation[];
  readonly runtimeSnapshot: RuntimeTestSnapshot | null;
  readonly recoveryError: {
    readonly title: string;
    readonly contentBytes: number;
    readonly contentSha256: string;
  } | null;
}

function consentDiagnostic(options: {
  readonly promptCount: number;
  readonly prompts: readonly RuntimeRecoveryPromptObservation[];
  readonly runtimeSnapshot: RuntimeTestSnapshot | null;
  readonly recoveryError: RuntimeRecoveryErrorObservation | null;
}): RuntimeRecoveryConsentDiagnostic {
  return {
    promptCount: options.promptCount,
    prompts: options.prompts,
    runtimeSnapshot: options.runtimeSnapshot,
    recoveryError: options.recoveryError
      ? {
          title: options.recoveryError.title,
          contentBytes: Buffer.byteLength(options.recoveryError.content, "utf8"),
          contentSha256: createHash("sha256")
            .update(options.recoveryError.content)
            .digest("hex"),
        }
      : null,
  };
}

class RuntimeRecoveryConsentValidationError extends Error {
  readonly diagnostic: RuntimeRecoveryConsentDiagnostic;

  constructor(message: string, diagnostic: RuntimeRecoveryConsentDiagnostic) {
    super(message);
    this.name = "RuntimeRecoveryConsentValidationError";
    this.diagnostic = diagnostic;
  }
}

class InterceptedRuntimeRecoveryError extends RuntimeRecoveryConsentValidationError {
  readonly contentBytes: number;
  readonly contentSha256: string;
  readonly recoveryTitle: string;

  constructor(
    title: string,
    content: string,
    diagnostic: RuntimeRecoveryConsentDiagnostic,
  ) {
    super(`${title}: ${content}`, diagnostic);
    this.name = "InterceptedRuntimeRecoveryError";
    this.recoveryTitle = title;
    this.contentBytes = Buffer.byteLength(content, "utf8");
    this.contentSha256 = createHash("sha256").update(content).digest("hex");
  }
}

type DiagnosticRead<T> =
  | { readonly status: "ok"; readonly value: T }
  | {
    readonly status: "error";
    readonly errorName: string;
    readonly errorCode: string | null;
  };

function diagnosticRead<T>(read: () => T): DiagnosticRead<T> {
  try {
    return { status: "ok", value: read() };
  } catch (error) {
    return {
      status: "error",
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorCode: error && typeof error === "object" && "code" in error
        ? String(error.code)
        : null,
    };
  }
}

export async function attachDarwinRecoverySafetyLockDiagnostic(
  testInfo: TestInfo,
  dataDirectory: string,
  priorGenerationId: string | null,
  error: unknown,
): Promise<void> {
  if (process.platform !== "darwin") return;
  // Capture the bounded raw topology before production readers get a chance
  // to finish or discard any safely repairable atomic-write transient.
  const rawTopology = diagnosticRead(() => {
    const root = pinDirectRuntimeJournalRoot(dataDirectory);
    return {
      rootIdentity: {
        device: String(root.device),
        inode: String(root.inode),
      },
      leaves: listDirectRuntimeJournalLeaves(
        root,
        ".runtime-",
        512,
      ).sort(),
    };
  });
  const leases = diagnosticRead(() => {
    const journal = new RuntimeGenerationLeaseJournal(dataDirectory);
    return {
      valid: journal.isValid(),
      entries: journal.all().map((lease) => ({ ...lease }))
        .sort((left, right) => left.runtimeGenerationId.localeCompare(
          right.runtimeGenerationId,
        )),
    };
  });
  const receipts = diagnosticRead(() => (
    new RuntimeCleanupReceiptJournal(dataDirectory).pending().sort()
  ));
  const owned = diagnosticRead(() => {
    if (!priorGenerationId) return { sessionPresent: null, records: [] };
    const records = new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    }).records(priorGenerationId);
    return {
      sessionPresent: records !== null,
      records: (records ?? []).map((record) => ({
        ownershipId: record.ownershipId,
        state: record.state,
        pid: record.state === "pending" ? null : record.process.pid,
        parentPid: record.state === "pending"
          ? record.runtimeParentPid
          : "parentPid" in record.process
            ? record.process.parentPid
            : null,
        processGroupId: record.state === "pending"
          ? null
          : "processGroupId" in record.process
            ? record.process.processGroupId
            : null,
        sessionId: record.state === "pending"
          ? null
          : "sessionId" in record.process
            ? record.process.sessionId
            : null,
      })).sort((left, right) => left.ownershipId.localeCompare(
        right.ownershipId,
      )),
    };
  });
  const modernAuthority = diagnosticRead(() => {
    const journal = new ModernDarwinRecoveryAuthorityJournal(dataDirectory);
    const summarize = (authority: ReturnType<typeof journal.pending>) => (
      authority
        ? {
          operationId: authority.operationId,
          snapshotDigest: authority.snapshotDigest,
          generationIds: authority.snapshot.generations.map(
            ({ lease }) => lease.runtimeGenerationId,
          ).sort(),
        }
        : null
    );
    return {
      pending: summarize(journal.pending()),
      retiring: summarize(journal.retiring()),
    };
  });
  const intercepted = error instanceof InterceptedRuntimeRecoveryError
    ? {
      title: error.recoveryTitle,
      contentBytes: error.contentBytes,
      contentSha256: error.contentSha256,
    }
    : null;
  await testInfo.attach("darwin-runtime-recovery-safety-lock", {
    body: Buffer.from(JSON.stringify({
      schemaVersion: 1,
      observedAt: new Date().toISOString(),
      observedAfterSafetyLock: true,
      rawTopology,
      semanticReadsAfterRawTopologyCapture: true,
      semanticReadsMayRepairAtomicTransients: true,
      priorGenerationId,
      intercepted,
      leases,
      receipts,
      owned,
      modernAuthority,
    }, null, 2), "utf8"),
    contentType: "application/json",
  });
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

function readOwnedProcessIdentity(
  pid: number,
): ObservedRuntimeOwnedProcessIdentity | null {
  if (process.platform === "linux") return readLinuxProcessIdentity(pid);
  if (process.platform === "darwin") {
    return readDarwinProcessIdentity(
      pid,
      join(
        process.cwd(),
        "resources/generated/runtime-process-guardian/runtime-process-guardian",
      ),
      { deadlineAt: Date.now() + 1_000 },
    );
  }
  return null;
}

async function runtimeWebsocketUrl(page: AppFixture["page"]): Promise<string> {
  return await page.evaluate(async () => {
    const connection = await window.inertia.getRuntimeConnection();
    if ("unavailable" in connection) {
      throw new Error(connection.message);
    }
    return connection.websocketUrl;
  });
}

export async function installRuntimeRecoveryConsent(
  electronApp: AppFixture["electronApp"],
): Promise<() => Promise<RuntimeRecoveryConsentDiagnostic>> {
  if (process.platform !== "darwin") {
    return async () => ({
      promptCount: 0,
      prompts: [],
      runtimeSnapshot: null,
      recoveryError: null,
    });
  }
  await electronApp.evaluate(({ dialog }, recoveryErrorTitles) => {
    const owner = globalThis as typeof globalThis & {
      __inertiaOriginalRuntimeRecoveryMessageBox?: typeof dialog.showMessageBox;
      __inertiaOriginalRuntimeRecoveryErrorBox?: typeof dialog.showErrorBox;
      __inertiaRuntimeRecoveryError?: {
        readonly title: string;
        readonly content: string;
      };
      __inertiaRuntimeRecoveryPromptCount?: number;
      __inertiaRuntimeRecoveryPrompts?: Array<{
        readonly generation: number | null;
        readonly phase: string | null;
        readonly lastError: string | null;
      }>;
    };
    owner.__inertiaOriginalRuntimeRecoveryMessageBox ??=
      dialog.showMessageBox.bind(dialog);
    owner.__inertiaOriginalRuntimeRecoveryErrorBox ??=
      dialog.showErrorBox.bind(dialog);
    const originalMessageBox = owner.__inertiaOriginalRuntimeRecoveryMessageBox;
    const originalErrorBox = owner.__inertiaOriginalRuntimeRecoveryErrorBox;
    owner.__inertiaRuntimeRecoveryPromptCount = 0;
    owner.__inertiaRuntimeRecoveryPrompts = [];
    Reflect.set(dialog, "showMessageBox", async (...args: unknown[]) => {
      const options = args.at(-1) as { title?: unknown } | undefined;
      if (options?.title === "Recover unproven macOS runtime state?") {
        owner.__inertiaRuntimeRecoveryPromptCount =
          (owner.__inertiaRuntimeRecoveryPromptCount ?? 0) + 1;
        const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
          snapshot?: () => {
            readonly generation?: unknown;
            readonly phase?: unknown;
            readonly lastError?: unknown;
          } | null;
        } | undefined;
        const snapshot = runtime?.snapshot?.() ?? null;
        owner.__inertiaRuntimeRecoveryPrompts?.push({
          generation: typeof snapshot?.generation === "number"
            ? snapshot.generation
            : null,
          phase: typeof snapshot?.phase === "string" ? snapshot.phase : null,
          lastError: typeof snapshot?.lastError === "string"
            ? snapshot.lastError
            : null,
        });
        // Keep the exact-title interception installed until bounded cleanup.
        // A failed replacement may offer another generation-specific prompt;
        // letting that prompt become native would block Electron main and hide
        // the actual repeated-recovery failure from the test runner.
        return {
          response: owner.__inertiaRuntimeRecoveryPromptCount === 1 ? 0 : 1,
          checkboxChecked: false,
        };
      }
      return Reflect.apply(originalMessageBox!, dialog, args);
    });
    Reflect.set(dialog, "showErrorBox", (title: string, content: string) => {
      if (recoveryErrorTitles.includes(title)) {
        owner.__inertiaRuntimeRecoveryError = { title, content };
        return;
      }
      Reflect.apply(originalErrorBox!, dialog, [title, content]);
    });
  }, [
    "Runtime recovery remains safety locked",
    "Runtime recovery was not authorized",
    "Legacy runtime recovery was not authorized",
  ]);

  let restoration: Promise<RuntimeRecoveryConsentDiagnostic> | null = null;
  return () => {
    restoration ??= (async () => {
      const result = await settleOperationBounded(
        Promise.resolve().then(() => electronApp.evaluate(({ dialog }) => {
          const owner = globalThis as typeof globalThis & {
            __inertiaOriginalRuntimeRecoveryMessageBox?:
              typeof dialog.showMessageBox;
            __inertiaOriginalRuntimeRecoveryErrorBox?:
              typeof dialog.showErrorBox;
            __inertiaRuntimeRecoveryError?: {
              readonly title: string;
              readonly content: string;
            };
            __inertiaRuntimeRecoveryPromptCount?: number;
            __inertiaRuntimeRecoveryPrompts?: Array<{
              readonly generation: number | null;
              readonly phase: string | null;
              readonly lastError: string | null;
            }>;
          };
          const originalMessageBox =
            owner.__inertiaOriginalRuntimeRecoveryMessageBox;
          const originalErrorBox = owner.__inertiaOriginalRuntimeRecoveryErrorBox;
          if (originalMessageBox) {
            Reflect.set(dialog, "showMessageBox", originalMessageBox);
          }
          if (originalErrorBox) {
            Reflect.set(dialog, "showErrorBox", originalErrorBox);
          }
          const recoveryError = owner.__inertiaRuntimeRecoveryError ?? null;
          const promptCount = owner.__inertiaRuntimeRecoveryPromptCount ?? 0;
          const prompts = owner.__inertiaRuntimeRecoveryPrompts ?? [];
          // Capture the supervisor state inside this already-bounded main
          // evaluation. A second evaluate after a crash could leave another
          // unresolved Playwright transport operation during fixture cleanup.
          const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
            snapshot?: () => RuntimeTestSnapshot | null;
          } | undefined;
          const runtimeSnapshot = runtime?.snapshot?.() ?? null;
          delete owner.__inertiaOriginalRuntimeRecoveryMessageBox;
          delete owner.__inertiaOriginalRuntimeRecoveryErrorBox;
          delete owner.__inertiaRuntimeRecoveryError;
          delete owner.__inertiaRuntimeRecoveryPromptCount;
          delete owner.__inertiaRuntimeRecoveryPrompts;
          return { promptCount, prompts, runtimeSnapshot, recoveryError };
        })),
        RUNTIME_RECOVERY_DIALOG_RESTORE_TIMEOUT_MS,
      );
      if (result.status === "fulfilled") {
        const diagnostic = consentDiagnostic(result.value);
        if (result.value.recoveryError) {
          throw new InterceptedRuntimeRecoveryError(
            result.value.recoveryError.title,
            result.value.recoveryError.content,
            diagnostic,
          );
        }
        if (result.value.promptCount > 1) {
          throw new RuntimeRecoveryConsentValidationError(
            `One deliberate crash required ${result.value.promptCount} explicit macOS runtime recovery decisions: ${JSON.stringify(result.value.prompts)}.`,
            diagnostic,
          );
        }
        return diagnostic;
      }
      if (result.status === "rejected") {
        throw new Error(
          "The runtime recovery dialog could not be restored.",
          { cause: result.reason },
        );
      }
      throw new Error("The runtime recovery dialog did not restore in time.");
    })();
    return restoration;
  };
}

export function runtimeRecoveryConsentDiagnostic(
  error: unknown,
): RuntimeRecoveryConsentDiagnostic | null {
  return error instanceof RuntimeRecoveryConsentValidationError
    ? error.diagnostic
    : null;
}

export async function expectRuntimeCrashRecovery(
  app: AppFixture,
  testInfo?: TestInfo,
): Promise<void> {
  const {
    electronApp,
    page,
    runtimeSnapshot,
    testDirectory,
    workspaceDirectory,
  } = app;
  await expect.poll(
    async () => (await runtimeSnapshot()).phase,
    { timeout: 15_000 },
  ).toBe("ready");
  const before = await runtimeSnapshot();
  const beforeObservation = runtimeObservation(before);
  const dataDirectory = join(testDirectory, "data");
  const priorLease = new RuntimeGenerationLeaseJournal(dataDirectory).all()
    .find((lease) =>
      lease.runtimeGenerationId.endsWith(`:${before.generation}`)) ?? null;
  const beforeUrl = await runtimeWebsocketUrl(page);
  const addFirstProject = page.getByRole("button", {
    name: "Add your first project",
  });
  if (await addFirstProject.isVisible().catch(() => false)) {
    await electronApp.evaluate(({ dialog }, directory) => {
      Reflect.set(dialog, "showOpenDialog", async () => ({
        canceled: false,
        filePaths: [directory],
        bookmarks: [],
      }));
    }, workspaceDirectory);
    await addFirstProject.click();
    await expect(page.getByRole("heading", {
      name: /^What should we build in .+\?$/u,
      level: 3,
    })).toBeVisible();
  }
  const projectNavigation = page.getByRole("complementary", {
    name: "Project navigation",
    exact: true,
  });
  const activeConversationId = (): string | null => {
    const current = new Database(join(testDirectory, "data", "inertia.sqlite"), {
      readonly: true,
    });
    try {
      return (current.prepare(`
        SELECT active_conversation_id
        FROM app_state
        WHERE id = 1
      `).get() as { active_conversation_id: string | null } | undefined)
        ?.active_conversation_id ?? null;
    } finally {
      current.close();
    }
  };
  const previousConversationId = activeConversationId();
  const activeConversationRow = projectNavigation.locator(
    '.conversation-row[aria-current="page"]',
  );
  const previousActiveConversationRow = await activeConversationRow.count() > 0
    ? await activeConversationRow.elementHandle()
    : null;
  await projectNavigation.getByRole("button", {
    name: "New chat",
    exact: true,
  }).click();
  let activeConversation: string | null = null;
  await expect.poll(() => {
    const candidate = activeConversationId();
    activeConversation = candidate && candidate !== previousConversationId
      ? candidate
      : null;
    return activeConversation;
  }).not.toBeNull();
  await expect.poll(() => activeConversationRow.evaluateAll((rows, previous) =>
    rows.length === 1 && (previous === null || rows[0] !== previous),
  previousActiveConversationRow)).toBe(true);
  await previousActiveConversationRow?.dispose();
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-runtime-generation",
    /^[0-9a-f-]{36}$/iu,
  );
  const beforeRuntimeGeneration = await page.locator(".app-shell")
    .getAttribute("data-runtime-generation");
  expect(beforeRuntimeGeneration).toMatch(/^[0-9a-f-]{36}$/iu);
  const tools = await ensureWorkspaceTools(page);
  const terminal = page.locator("aside.terminal-panel").first();
  const restartTerminal = terminal.getByRole("button", { name: "Start again" });
  let retriedTerminalAdmission = false;
  await expect.poll(async () => {
    if (await tools.getAttribute("data-active-workspace-tool") !== "terminal") {
      await selectWorkspaceTool(tools, "Terminal");
      return false;
    }
    if (await terminal.count() === 0) return false;
    if (await terminal.getAttribute("data-terminal-id", { timeout: 500 })
      .catch(() => null)) return true;
    if (
      !retriedTerminalAdmission
      && await restartTerminal.isVisible().catch(() => false)
    ) {
      retriedTerminalAdmission = true;
      await restartTerminal.click();
    }
    return false;
  }, { timeout: 15_000 }).toBe(true);
  await expect(terminal).toHaveAttribute("data-terminal-id", /.+/u);
  const beforeTerminalId = await terminal.getAttribute("data-terminal-id");
  expect(beforeTerminalId).toBeTruthy();
  let recoveryRootPid: number | null = null;
  let recoveryGuardianPid: number | null = null;
  if (process.platform === "linux") {
    // Keep the exact claimed terminal root alive after the utility process is
    // killed. An ordinary interactive shell exits when its PTY owner dies,
    // which intentionally exercises the separate missing-root fail-closed
    // boundary instead of the positive exact-identity recovery path below.
    // Publish readiness outside the renderer after installing the SIGHUP
    // handler. Reading xterm's DOM can itself stall on a loaded native runner,
    // while this unique file proves the exact helper reached the same point.
    const recoveryRootReadyPath = join(
      testDirectory,
      `runtime-recovery-root-ready-${randomUUID()}.txt`,
    );
    const recoveryRootSource = [
      "process.on('SIGHUP', () => undefined);",
      `require('node:fs').writeFileSync(${JSON.stringify(recoveryRootReadyPath)},String(process.pid),{encoding:'utf8',flag:'wx'});`,
      "setInterval(() => undefined, 1000);",
    ].join("");
    const terminalInput = terminal.locator(".xterm-helper-textarea");
    await terminalInput.focus();
    await page.keyboard.insertText(
      `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(recoveryRootSource)}`,
    );
    await page.keyboard.press("Enter");
    await expect.poll(() => {
      let pid = 0;
      try {
        pid = Number(readFileSync(recoveryRootReadyPath, "utf8").trim());
      } catch {
        return null;
      }
      recoveryRootPid = Number.isSafeInteger(pid) && pid > 1 ? pid : null;
      if (recoveryRootPid) {
        const identity = readLinuxProcessIdentity(recoveryRootPid);
        recoveryGuardianPid = identity?.parentPid && identity.parentPid > 1
          ? identity.parentPid
          : null;
      }
      return recoveryRootPid;
    }, { timeout: 15_000, intervals: [25] }).not.toBeNull();
    expect(recoveryGuardianPid).not.toBeNull();
  }
  if (process.platform === "win32") {
    expect(priorLease).not.toBeNull();
    const journal = new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "win32",
    });
    // An active terminal admission can briefly make an ordinary journal read
    // fail closed while its temporary leaf is being committed. Require the
    // durable containment record before crashing the runtime, but do not turn
    // that safe transient into an ARM64-only timing failure.
    await expect.poll(
      () => journal.containment(priorLease!.runtimeGenerationId),
      { timeout: 15_000, intervals: [25] },
    ).toEqual({
      kind: "windows-job-v1",
      name: expect.stringMatching(/^Global\\InertiaRuntime-[0-9a-f]{64}$/u),
    });
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
    expect(recoveryGuardianPid).not.toBeNull();
    const journal = new RuntimeOwnedProcessJournal(dataDirectory);
    let stableSince: number | null = null;
    let stableSignature: string | null = null;
    let latestDiagnostic: unknown = null;
    const quiescenceStartedAt = Date.now();
    const observedClaims = new Map<string, {
      firstSeenMs: number;
      lastSeenMs: number;
      samples: number;
      states: Set<"owned" | "pending" | "preauth" | "retiring">;
    }>();
    try {
      // Admission may consume both bounded 1.5-second attempts at each Linux
      // ready/claim/exec phase on a loaded native runner. Keep this proof
      // outside that fail-closed production envelope before forcing a crash.
      await expect.poll(() => {
        const records = journal.records(priorLease!.runtimeGenerationId);
        const systemBootId = readSystemBootId();
        let allExact = Boolean(records?.length);
        let intendedGuardianExact = false;
        const claims = (records ?? []).map((record) => {
          const observedAtMs = Date.now() - quiescenceStartedAt;
          const observation = observedClaims.get(record.ownershipId) ?? {
            firstSeenMs: observedAtMs,
            lastSeenMs: observedAtMs,
            samples: 0,
            states: new Set<"owned" | "pending" | "preauth" | "retiring">(),
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
          intendedGuardianExact ||= exact
            && record.systemBootId === systemBootId
            && record.process.pid === recoveryGuardianPid;
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
          intendedGuardianPid: recoveryGuardianPid,
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
        if (!allExact || !intendedGuardianExact || !records) {
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
      }, { timeout: 15_000, intervals: [25] }).toBe(true);
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

  const restoreRuntimeRecoveryConsent = await installRuntimeRecoveryConsent(
    electronApp,
  );
  let crashed: RuntimeTestSnapshot | null = null;
  let after: RuntimeTestSnapshot | null = null;
  let recoveryOperationError: unknown = null;
  let recoveryOperationFailed = false;
  try {
    crashed = await electronApp.evaluate((_electron) => {
      const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
        crash: () => RuntimeTestSnapshot;
      } | undefined;
      if (!runtime) throw new Error("The test runtime supervisor is unavailable");
      return runtime.crash();
    });
    await expect.poll(async () => {
      const shell = page.locator(".app-shell");
      const [connectionStatus, runtimeGeneration] = await Promise.all([
        shell.getAttribute("data-connection-status", { timeout: 500 })
          .catch(() => null),
        shell.getAttribute("data-runtime-generation", { timeout: 500 })
          .catch(() => null),
      ]);
      return connectionStatus === "online"
        && runtimeGeneration !== null
        && runtimeGeneration !== beforeRuntimeGeneration;
    }, { timeout: 20_000 }).toBe(true);
    after = await runtimeSnapshot();
    expect(after.phase).toBe("ready");
    expect(after.generation).toBeGreaterThan(before.generation);
  } catch (error) {
    recoveryOperationFailed = true;
    recoveryOperationError = error;
  }
  let recoveryConsentError: unknown = null;
  let recoveryConsentFailed = false;
  let recoveryConsent: RuntimeRecoveryConsentDiagnostic | null = null;
  try {
    recoveryConsent = await restoreRuntimeRecoveryConsent();
  } catch (error) {
    recoveryConsentFailed = true;
    recoveryConsentError = error;
    recoveryConsent = runtimeRecoveryConsentDiagnostic(error);
  }
  if ((recoveryOperationFailed || recoveryConsentFailed) && testInfo) {
    await testInfo.attach("runtime recovery consent diagnostic", {
      body: Buffer.from(JSON.stringify({ recoveryConsent }, null, 2), "utf8"),
      contentType: "application/json",
    }).catch(() => undefined);
    await attachDarwinRecoverySafetyLockDiagnostic(
      testInfo,
      dataDirectory,
      priorLease?.runtimeGenerationId ?? null,
      recoveryConsentFailed ? recoveryConsentError : recoveryOperationError,
    ).catch(() => undefined);
  }
  if (recoveryOperationFailed && recoveryConsentFailed) {
    throw new AggregateError(
      [recoveryOperationError, recoveryConsentError],
      "Runtime recovery and recovery-consent restoration both failed.",
    );
  }
  if (recoveryConsentFailed) throw recoveryConsentError;
  if (recoveryOperationFailed) throw recoveryOperationError;
  if (!crashed || !after) {
    throw new Error("The runtime crash-recovery result was incomplete.");
  }
  const crashReturnedObservation = runtimeObservation(crashed);
  expect(crashed.pid).toBe(before.pid);
  const replacementReadyObservation = runtimeObservation(after);
  const afterUrl = await runtimeWebsocketUrl(page);
  expect(after.generation).toBeGreaterThan(before.generation);
  expect(after.pid).not.toBe(before.pid);
  expect(afterUrl).not.toBe(beforeUrl);
  await expect.poll(() => page.locator(".app-shell")
    .getAttribute("data-runtime-generation")).not.toBe(beforeRuntimeGeneration);
  expect(await page.evaluate(() =>
    Reflect.get(window, "__inertiaNoReloadMarker"))).toBe(marker);
  await expect(page.getByRole("heading", { name: "New chat", level: 1 })).toBeVisible();
  const newChat = page.getByRole("button", {
    name: "New chat",
    exact: true,
  });
  const interruptedNotice = page.getByText(
    "The previous run ended when Inertia closed. Send another message to continue.",
  );
  await expect(page.getByRole("heading", { name: "Timeline response", level: 1 }))
    .toBeVisible();
  await expect(page.getByRole("button", { name: "Copy" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Markdown" })).toBeVisible();
  expect(await page.evaluate(() =>
    Reflect.get(window, "__unsafeMarkdown"))).toBeUndefined();
  const safetyAlert = page.locator(".error-toast[role=\"alert\"]").filter({
    hasText: /recovery safety mode|prior runtime-owned process|unconfirmed process cleanup|confirm complete process cleanup/iu,
  });
  await expect(newChat).toBeEnabled();
  let safetyAlertWon = false;
  await expect.poll(async () => {
    safetyAlertWon = await safetyAlert.isVisible().catch(() => false);
    return safetyAlertWon
      || await interruptedNotice.isVisible().catch(() => false);
  }).toBe(true);
  if (
    testInfo
    && priorLease
    && safetyAlertWon
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
        currentIdentity = readOwnedProcessIdentity(record.process.pid);
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
  if (testInfo) {
    const evidence = testInfo.outputPath("runtime-crash-recovered.png");
    await page.screenshot({ animations: "disabled", path: evidence });
    await testInfo.attach("runtime crash recovery", {
      path: evidence,
      contentType: "image/png",
    });
    const requestedPath = process.env.INERTIA_RUNTIME_CRASH_SCREENSHOT_PATH;
    if (requestedPath) {
      if (!isAbsolute(requestedPath)) {
        throw new Error(
          "INERTIA_RUNTIME_CRASH_SCREENSHOT_PATH must be absolute.",
        );
      }
      copyFileSync(evidence, requestedPath);
    }
  }
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
