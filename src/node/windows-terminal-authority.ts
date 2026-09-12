import { win32 } from "node:path";

/** Trusted main-to-runtime native helper identity; never renderer input. */
export interface WindowsTerminalAuthority {
  readonly path: string;
  readonly sha256: string;
}

export function parseWindowsTerminalAuthority(value: unknown): WindowsTerminalAuthority | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).length !== 2
    || typeof candidate.path !== "string" || candidate.path.length > 32767
    || !win32.isAbsolute(candidate.path) || /[\0\r\n]/u.test(candidate.path)
    || typeof candidate.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.sha256)) return null;
  return { path: candidate.path, sha256: candidate.sha256 };
}
