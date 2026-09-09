/** Release metadata is untrusted presentation text, never HTML or navigation authority. */
export function appUpdateReleaseNotes(value: unknown, version: string): string | null {
  const notes = Array.isArray(value)
    ? value.slice(0, 32).find((item: unknown) => typeof item === "object" && item !== null
      && "version" in item && item.version === version)
    : typeof value === "string" ? value : null;
  const text = typeof notes === "string" ? notes
    : typeof notes === "object" && notes !== null && "note" in notes ? notes.note : null;
  if (typeof text !== "string") return null;
  // Bound processing and IPC size. The UI permits safe formatting, not raw HTML/URLs.
  const bounded = text.slice(0, 8_192).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, "").trim();
  return bounded ? `${bounded}${text.length > 8_192 ? "\n…" : ""}` : null;
}
