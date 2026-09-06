import { createHash } from "node:crypto";
import type { AppFixture, RuntimeTestSnapshot } from "./app-fixture";
import { settleOperationBounded } from "./electron-app-lifecycle";

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

export class InterceptedRuntimeRecoveryError extends RuntimeRecoveryConsentValidationError {
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
      const options = args.at(-1) as {
        title?: unknown; message?: unknown; cancelId?: unknown;
      } | undefined;
      if (typeof options?.title === "string"
        && recoveryErrorTitles.includes(options.title)
        && typeof options.message === "string") {
        owner.__inertiaRuntimeRecoveryError = {
          title: options.title, content: options.message,
        };
        return {
          response: typeof options.cancelId === "number" ? options.cancelId : 0,
          checkboxChecked: false,
        };
      }
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
        // record it without waiting for another user decision so the runner
        // can report the actual repeated-recovery failure.
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
