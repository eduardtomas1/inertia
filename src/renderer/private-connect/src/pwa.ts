const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONVERSATION_FRAGMENT_PREFIX = "#conversation=";
const OPEN_CONVERSATION_MESSAGE = "private-connect.open-conversation";

export function privateConnectConversationIdFromFragment(
  fragment: string,
): string | null {
  if (!fragment.startsWith(CONVERSATION_FRAGMENT_PREFIX)) return null;
  const conversationId = fragment.slice(CONVERSATION_FRAGMENT_PREFIX.length);
  return UUID_PATTERN.test(conversationId) ? conversationId : null;
}

export function privateConnectConversationDeepLink(
  conversationId: string,
): string {
  return UUID_PATTERN.test(conversationId)
    ? `/${CONVERSATION_FRAGMENT_PREFIX}${conversationId}`
    : "/";
}

export async function registerPrivateConnectServiceWorker(): Promise<
  ServiceWorkerRegistration | null
> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/service-worker.js", {
      scope: "/",
      updateViaCache: "none",
    });
  } catch {
    // Installability is progressive enhancement; direct private access remains.
    return null;
  }
}

export function onPrivateConnectConversationNavigation(
  listener: (conversationId: string) => void,
): () => void {
  if (!("serviceWorker" in navigator)) return () => undefined;
  const receive = (event: MessageEvent<unknown>): void => {
    const value = event.data;
    if (
      typeof value !== "object"
      || value === null
      || Array.isArray(value)
      || Object.keys(value).length !== 2
      || Reflect.get(value, "type") !== OPEN_CONVERSATION_MESSAGE
    ) return;
    const conversationId = Reflect.get(value, "conversationId");
    if (typeof conversationId === "string" && UUID_PATTERN.test(conversationId)) {
      listener(conversationId);
    }
  };
  navigator.serviceWorker.addEventListener("message", receive);
  return () => navigator.serviceWorker.removeEventListener("message", receive);
}
