/** Window chrome has a tighter title contract than stored conversation text. */
export function detachedChatWindowTitle(title: string): string {
  return title.replace(/[\0\r\n]+/gu, " ").trim().slice(0, 120)
    .replace(/[\uD800-\uDBFF]$/u, "") || "Untitled chat";
}
