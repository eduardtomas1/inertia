import { createDialogSwitch } from "./dialogSwitch";
import { setNativePreviewSuspension } from "./nativePreviewOverlay";

const helpGuide = createDialogSwitch();
const REQUEST_SUSPENSION = "help-guide-request";

export const subscribeHelpGuide = helpGuide.subscribe;
export const helpGuideIsOpen = helpGuide.isOpen;

export function openHelpGuide(): void {
  if (!helpGuide.isOpen()) setNativePreviewSuspension(REQUEST_SUSPENSION, true);
  helpGuide.open();
}

export function settleHelpGuideRequest(): void {
  setNativePreviewSuspension(REQUEST_SUSPENSION, false);
}

export function closeHelpGuide(): void {
  settleHelpGuideRequest();
  helpGuide.close();
}
