import type { InterfaceScale } from "@shared/contracts";

export const INTERFACE_SCALE_WILL_CHANGE_EVENT = "inertia:interface-scale-will-change";

export function applyInterfaceScale(scale: InterfaceScale): void {
  if (document.documentElement.dataset.interfaceScale === scale) return;
  window.dispatchEvent(new Event(INTERFACE_SCALE_WILL_CHANGE_EVENT));
  document.documentElement.dataset.interfaceScale = scale;
}
