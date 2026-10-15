import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";

export async function readClaudeSessionTitle(sessionId: string, dir: string): Promise<string | undefined> {
  return (await getSessionInfo(sessionId, { dir }))?.customTitle;
}
