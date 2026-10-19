import type { AppUnderTestErrorCode } from "../../../shared/app-under-test";

/** A failure whose message is fixed wording that is safe to show a model or user. */
export class AppUnderTestError extends Error {
  constructor(
    readonly code: AppUnderTestErrorCode,
    message: string,
    /** True when input may already have reached the app. */
    readonly dispatched = false,
  ) {
    super(message);
    this.name = "AppUnderTestError";
  }
}
