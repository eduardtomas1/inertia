import type { CursorSdkModel } from "../../../shared/cursor-sdk-models";
import type { CursorSdkModelsResult, CursorSdkStatusResult } from "../../../shared/cursor-sdk-auth";
import { cursorSdkModelsResultSchema, cursorSdkStatusResultSchema } from "../../../shared/contracts/cursor-sdk-auth-schema";
import { RuntimeRequestError } from "../../runtime-errors";
import { isProcessTreeTerminationUnconfirmed } from "../../process-lifecycle";

type ProbeKind = "status" | "models";
type ProbeResult = CursorSdkModelsResult | CursorSdkStatusResult;

export const CURSOR_SDK_CLEANUP_UNCONFIRMED_MESSAGE =
  "Cursor SDK worker cleanup is unconfirmed. Restart the application to recover.";

export interface CursorSdkAccountProbeDependencies {
  signal: AbortSignal;
  status(signal: AbortSignal): Promise<Omit<CursorSdkStatusResult, "kind">>;
  models(signal: AbortSignal): Promise<CursorSdkModel[]>;
  track<T>(operation: () => Promise<T>): Promise<T>;
}

export class CursorSdkAccountProbes {
  private active: { kind: ProbeKind; result: Promise<ProbeResult> } | undefined;
  private quarantined = false;

  constructor(private readonly dependencies: CursorSdkAccountProbeDependencies) {}

  get pending(): boolean { return this.active !== undefined; }
  get cleanupUnconfirmed(): boolean { return this.quarantined; }

  read(kind: ProbeKind): Promise<ProbeResult> {
    if (this.quarantined) return Promise.reject(new RuntimeRequestError(CURSOR_SDK_CLEANUP_UNCONFIRMED_MESSAGE));
    if (this.active) {
      if (this.active.kind === kind) return this.active.result;
      return Promise.reject(new RuntimeRequestError("Wait for the current Cursor SDK availability check to finish."));
    }
    const deadline = new AbortController();
    const signal = AbortSignal.any([this.dependencies.signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(), 35_000);
    timer.unref();
    const result = Promise.resolve().then(() => this.dependencies.track(async () => {
      signal.throwIfAborted();
      const value = await this.load(kind, signal);
      signal.throwIfAborted();
      return value;
    })).catch((error: unknown) => {
      this.quarantined = isProcessTreeTerminationUnconfirmed(error);
      if (this.quarantined) {
        throw new RuntimeRequestError(CURSOR_SDK_CLEANUP_UNCONFIRMED_MESSAGE);
      }
      throw new RuntimeRequestError(kind === "status"
        ? "Cursor SDK availability could not be checked."
        : "Cursor SDK models could not be loaded.");
    }).finally(() => {
      clearTimeout(timer);
      if (!this.quarantined) this.active = undefined;
    });
    this.active = { kind, result };
    return result;
  }

  private async load(kind: ProbeKind, signal: AbortSignal): Promise<ProbeResult> {
    if (kind === "status") {
      const status = await this.dependencies.status(signal);
      return cursorSdkStatusResultSchema.parse({
        kind: "provider.cursor-sdk.status", available: status.available,
        hasCredential: status.hasCredential, sdkVersion: status.sdkVersion,
      });
    }
    const models = await this.dependencies.models(signal);
    return cursorSdkModelsResultSchema.parse({
      kind: "provider.cursor-sdk.models", models: models.map(({ id, displayName }) => ({ id, displayName })),
    });
  }
}
