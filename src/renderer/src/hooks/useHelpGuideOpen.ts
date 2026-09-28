import { useSyncExternalStore } from "react";

import { helpGuideIsOpen, subscribeHelpGuide } from "../utils/helpGuide";

export function useHelpGuideOpen(): boolean {
  return useSyncExternalStore(subscribeHelpGuide, helpGuideIsOpen);
}
