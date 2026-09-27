import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { withOpenCodeRequestDeadline } from "./opencode-owned-server";

export interface OpenCodeReplyTarget {
  protocol: "legacy" | "v2";
  sessionId: string;
  nativeId: string;
}

export interface OpenCodeInteractionReplies {
  permission(target: OpenCodeReplyTarget, reply: "once" | "reject"): Promise<void>;
  question(target: OpenCodeReplyTarget, answers: string[][]): Promise<void>;
  rejectQuestion(target: OpenCodeReplyTarget): Promise<void>;
}

export function boundedOpenCodeInteractionReplies(
  client: OpencodeClient,
  timeoutMs: number,
  runSignal: AbortSignal,
): OpenCodeInteractionReplies {
  const bounded = async (
    kind: "permission reply" | "question reply" | "question rejection",
    operation: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<void> => {
    await withOpenCodeRequestDeadline(
      timeoutMs,
      `Timed out waiting for OpenCode to confirm the ${kind}.`,
      operation,
      runSignal,
    );
  };
  return {
    permission: async ({ protocol, sessionId, nativeId }, reply) =>
      await bounded("permission reply", async (signal) => protocol === "v2"
        ? await client.v2.session.permission.reply(
            { sessionID: sessionId, requestID: nativeId, reply },
            { signal, throwOnError: true },
          )
        : await client.permission.reply(
            { requestID: nativeId, reply },
            { signal, throwOnError: true },
          )),
    question: async ({ protocol, sessionId, nativeId }, answers) =>
      await bounded("question reply", async (signal) => protocol === "v2"
        ? await client.v2.session.question.reply(
            { sessionID: sessionId, requestID: nativeId, questionV2Reply: { answers } },
            { signal, throwOnError: true },
          )
        : await client.question.reply(
            { requestID: nativeId, answers },
            { signal, throwOnError: true },
          )),
    rejectQuestion: async ({ protocol, sessionId, nativeId }) =>
      await bounded("question rejection", async (signal) => protocol === "v2"
        ? await client.v2.session.question.reject(
            { sessionID: sessionId, requestID: nativeId },
            { signal, throwOnError: true },
          )
        : await client.question.reject(
            { requestID: nativeId },
            { signal, throwOnError: true },
          )),
  };
}
