import { commandExecutionLabel } from "./app-server-config";
import { boundedText, objectValue, stringValue, type JsonObject } from "./protocol";

export function codexMcpToolLabel(item: JsonObject): string {
  const server = boundedText(item.server, 120);
  const tool = boundedText(item.tool, 160);
  return server && tool
    ? `MCP · ${server}/${tool}`
    : tool ? `MCP · ${tool}` : "MCP tool";
}

export function codexDynamicToolLabel(item: JsonObject): string {
  const tool = boundedText(item.tool, 160);
  return tool ? `Tool · ${tool}` : "Dynamic tool";
}

export function codexWebSearchActivity(
  item: JsonObject,
): { label: string; detail?: string } {
  const action = objectValue(item.action);
  const actionType = stringValue(action?.type);
  if (actionType === "openPage") {
    const url = boundedText(action?.url, 4_000);
    return { label: "Open web page", ...(url ? { detail: `URL:\n${url}` } : {}) };
  }
  if (actionType === "findInPage") {
    const url = boundedText(action?.url, 4_000);
    const pattern = boundedText(action?.pattern, 1_000);
    const detail = [
      url ? `URL:\n${url}` : null,
      pattern ? `Pattern:\n${pattern}` : null,
    ].filter((part): part is string => Boolean(part)).join("\n\n");
    return { label: "Find on web page", ...(detail ? { detail } : {}) };
  }
  const query = boundedText(action?.query, 4_000)
    ?? boundedText(item.query, 4_000);
  return {
    label: "Search the web",
    ...(query ? { detail: `Query:\n${query}` } : {}),
  };
}

export function codexItemActivityLabel(item: JsonObject): string | null {
  switch (stringValue(item.type)) {
    case "reasoning":
      return "Thinking";
    case "commandExecution":
      return commandExecutionLabel(item);
    case "fileChange":
      return "File change";
    case "mcpToolCall":
      return codexMcpToolLabel(item);
    case "dynamicToolCall":
      return codexDynamicToolLabel(item);
    case "webSearch":
      return codexWebSearchActivity(item).label;
    case "imageView":
      return "View image";
    case "imageGeneration":
      return "Generate image";
    case "contextCompaction":
      return "Context compaction";
    default:
      return null;
  }
}
