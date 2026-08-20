export type RuntimeClientAuthority =
  | { kind: "main" }
  | {
      kind: "detached-chat";
      conversationId: string;
      clientId: string;
    };

export const MAIN_RUNTIME_CLIENT_AUTHORITY: RuntimeClientAuthority =
  Object.freeze({ kind: "main" });
