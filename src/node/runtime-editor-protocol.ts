import { isPreferredEditor, type PreferredEditor } from "../shared/editors";
import { UUID_PATTERN } from "../shared/request-identifiers";

export interface RuntimeEditorContextQuery {
  type: "runtime.editor-context";
  requestId: string;
  filePath?: string;
}

export interface RuntimeEditorContextResult {
  preferredEditor: PreferredEditor;
  authorizedPath?: string;
  projectRoot?: string;
}

export type RuntimeEditorContextEvent =
  | ({
      type: "runtime.editor-context-resolved";
      requestId: string;
    } & RuntimeEditorContextResult)
  | {
      type: "runtime.editor-context-rejected";
      requestId: string;
      message: string;
    };

const MAX_PATH_LENGTH = 4_096;

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_PATH_LENGTH
    && !/[\0\r\n]/u.test(value);
}

export function parseRuntimeEditorCommand(value: unknown): RuntimeEditorContextQuery | null {
  if (!plainObject(value) || value.type !== "runtime.editor-context") return null;
  const hasFilePath = Object.hasOwn(value, "filePath");
  const keys = Object.keys(value);
  if (
    keys.length !== (hasFilePath ? 3 : 2)
    || !keys.every((key) => key === "type" || key === "requestId" || key === "filePath")
    || typeof value.requestId !== "string"
    || !UUID_PATTERN.test(value.requestId)
    || (hasFilePath && !validPath(value.filePath))
  ) return null;
  return {
    type: "runtime.editor-context",
    requestId: value.requestId,
    ...(hasFilePath ? { filePath: value.filePath as string } : {}),
  };
}

export function parseRuntimeEditorEvent(value: unknown): RuntimeEditorContextEvent | null {
  if (!plainObject(value)) return null;
  if (value.type === "runtime.editor-context-rejected") {
    const keys = Object.keys(value);
    if (
      keys.length !== 3
      || !keys.every((key) => key === "type" || key === "requestId" || key === "message")
      || typeof value.requestId !== "string"
      || !UUID_PATTERN.test(value.requestId)
      || typeof value.message !== "string"
      || value.message.trim().length === 0
      || value.message.length > 1_000
    ) return null;
    return {
      type: "runtime.editor-context-rejected",
      requestId: value.requestId,
      message: value.message,
    };
  }
  if (value.type !== "runtime.editor-context-resolved") return null;
  const hasAuthorizedPath = Object.hasOwn(value, "authorizedPath");
  const hasProjectRoot = Object.hasOwn(value, "projectRoot");
  const keys = Object.keys(value);
  if (
    keys.length !== 3 + Number(hasAuthorizedPath) + Number(hasProjectRoot)
    || !keys.every((key) =>
      key === "type"
      || key === "requestId"
      || key === "preferredEditor"
      || key === "authorizedPath"
      || key === "projectRoot")
    || typeof value.requestId !== "string"
    || !UUID_PATTERN.test(value.requestId)
    || !isPreferredEditor(value.preferredEditor)
    || (hasAuthorizedPath && !validPath(value.authorizedPath))
    || (hasProjectRoot && !validPath(value.projectRoot))
  ) return null;
  return {
    type: "runtime.editor-context-resolved",
    requestId: value.requestId,
    preferredEditor: value.preferredEditor,
    ...(hasAuthorizedPath ? { authorizedPath: value.authorizedPath as string } : {}),
    ...(hasProjectRoot ? { projectRoot: value.projectRoot as string } : {}),
  };
}
