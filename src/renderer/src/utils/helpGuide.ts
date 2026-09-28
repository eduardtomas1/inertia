import { createDialogSwitch } from "./dialogSwitch";

const helpGuide = createDialogSwitch();

export const subscribeHelpGuide = helpGuide.subscribe;
export const helpGuideIsOpen = helpGuide.isOpen;
export const openHelpGuide = helpGuide.open;
export const closeHelpGuide = helpGuide.close;
