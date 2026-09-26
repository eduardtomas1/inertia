import type { ServerEvent } from "./events";

/** Keep the public parse/safeParse surface consistent at the runtime boundary. */
export function serverEventBoundary(validate: (value: unknown) => value is ServerEvent) {
  const parse = (value: unknown): ServerEvent => {
    if (!validate(value)) throw new Error("Malformed server event");
    return value;
  };
  return Object.freeze({
    parse,
    safeParse(value: unknown): { success: true; data: ServerEvent } | { success: false; error: Error } {
      try { return { success: true, data: parse(value) }; }
      catch (error) { return { success: false, error: error instanceof Error ? error : new Error("Malformed server event") }; }
    },
  });
}
