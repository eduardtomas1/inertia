export type CursorSdkLoginState =
  | { status: "starting" | "cancelling" | "cancelled" | "expired" | "failed" }
  | { status: "waiting"; loginUrl: string }
  | { status: "authenticated"; expiresAt: number };

export type CursorSdkLoginEvent = {
  type: "provider.cursor-sdk.login.updated";
  loginRequestId: string;
} & CursorSdkLoginState;

export interface CursorSdkStatusResult {
  kind: "provider.cursor-sdk.status";
  available: boolean;
  hasCredential: boolean;
  sdkVersion: "1.0.38";
}

export interface CursorSdkModelsResult {
  kind: "provider.cursor-sdk.models";
  models: import("./cursor-sdk-models").CursorSdkModel[];
}

export function isCursorSdkLoginUrl(value: string): boolean {
  if (!value || value.length > 8192 || /[\u0000-\u0020\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.origin === "https://cursor.com" && !url.username && !url.password;
  } catch {
    return false;
  }
}
