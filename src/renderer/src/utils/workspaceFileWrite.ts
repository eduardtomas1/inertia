import {
  clientCommandSchema,
  type ClientCommand,
} from "@shared/contracts";
import { serializeRuntimeClientCommand } from "@shared/runtime-websocket";

type WorkspaceFileWriteCommand = Extract<
  ClientCommand,
  { type: "workspace.file.write" }
>;

export type WorkspaceFileWriteIdentity = Omit<
  WorkspaceFileWriteCommand["payload"],
  "content"
>;

const PREFLIGHT_REQUEST_ID = "00000000-0000-4000-8000-000000000000";

export function workspaceFileWriteCommand(
  identity: WorkspaceFileWriteIdentity,
  content: string,
): Omit<WorkspaceFileWriteCommand, "requestId"> {
  return {
    type: "workspace.file.write",
    payload: { ...identity, content },
  };
}

export function workspaceFileWriteFitsRuntimeFrame(
  identity: WorkspaceFileWriteIdentity,
  content: string,
): boolean {
  const parsed = clientCommandSchema.safeParse({
    ...workspaceFileWriteCommand(identity, content),
    requestId: PREFLIGHT_REQUEST_ID,
  });
  if (!parsed.success) return false;
  try {
    serializeRuntimeClientCommand(parsed.data);
    return true;
  } catch {
    return false;
  }
}
