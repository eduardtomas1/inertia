import { HTML_RENDER_PROTOCOL_HOST } from "@shared/html-render";
import { appProtocolScheme } from "./composerAttachments";

/**
 * The privileged route that serves a visual reply's page. It lives beside the
 * attachment preview route's scheme logic but stays out of the startup bundle.
 */
export function htmlRenderUrl(renderId: string): string {
  return `${appProtocolScheme()}://${HTML_RENDER_PROTOCOL_HOST}/${encodeURIComponent(renderId)}`;
}
