import { z } from "zod";

export const privateConnectScopeSchema = z.enum([
  "private:read",
  "private:prompt",
  "private:input",
  "private:stop",
]);
export type PrivateConnectScope = z.infer<typeof privateConnectScopeSchema>;

export const privateConnectPresetSchema = z.enum(["monitor", "collaborate"]);
export type PrivateConnectPreset = z.infer<typeof privateConnectPresetSchema>;

export function scopesForPreset(
  preset: PrivateConnectPreset,
): PrivateConnectScope[] {
  return preset === "collaborate"
    ? ["private:read", "private:prompt", "private:input", "private:stop"]
    : ["private:read"];
}

export function presetForScopes(
  scopes: readonly PrivateConnectScope[],
): PrivateConnectPreset {
  return scopes.includes("private:prompt")
    || scopes.includes("private:input")
    || scopes.includes("private:stop")
    ? "collaborate"
    : "monitor";
}

export function hasPrivateConnectScope(
  scopes: readonly PrivateConnectScope[],
  scope: PrivateConnectScope,
): boolean {
  return scopes.includes(scope);
}
