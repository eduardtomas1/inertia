import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";

export async function readClaudeSessionTitle(sessionId: string): Promise<string | undefined> {
  return (await getSessionInfo(sessionId))?.customTitle;
}
