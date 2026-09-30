export interface DialogSwitch {
  subscribe: (listener: () => void) => () => void;
  isOpen: () => boolean;
  open: () => void;
  close: () => void;
}

export function createDialogSwitch(): DialogSwitch {
  const listeners = new Set<() => void>();
  let open = false;
  const publish = (next: boolean): void => {
    if (open === next) return;
    open = next;
    for (const listener of listeners) listener();
  };
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isOpen: () => open,
    open: () => publish(true),
    close: () => publish(false),
  };
}
