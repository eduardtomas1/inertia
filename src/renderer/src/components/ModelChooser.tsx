import { useEffect, useId, useRef, useState } from "react";
import { useLoadedSurface } from "../hooks/useLoadedSurface";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { createSurfaceLoader } from "../utils/surfaceLoader";
import { outsidePointerShouldRestoreFocus } from "../utils/dismissibleMenu";
import { SelectedModelChip } from "./SelectedModelChip";
import type { ModelChooserProps } from "./ModelChooserLoaded";

export type { ModelChooserProps } from "./ModelChooserLoaded";

const loadModelChooser = createSurfaceLoader(async () => ({
  default: (await import("./ModelChooserLoaded")).ModelChooser,
}));

export function ModelChooser(props: ModelChooserProps): React.JSX.Element {
  const { onOpenChange, disabled, closeSignal } = props;
  const [activated, setActivated] = useState(false);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const Loaded = useLoadedSurface(loadModelChooser, activated);
  const pending = open && !Loaded;
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useNativePreviewSuspension(open);
  useEffect(() => {
    if (!pending) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      onOpenChange?.(false);
      trigger.current?.focus();
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && anchor.current?.contains(event.target)) return;
      setOpen(false);
      onOpenChange?.(false);
      if (outsidePointerShouldRestoreFocus(event.target)) trigger.current?.focus();
    };
    document.addEventListener("keydown", cancel, true);
    document.addEventListener("pointerdown", outside, true);
    return () => {
      document.removeEventListener("keydown", cancel, true);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [pending, onOpenChange]);
  useEffect(() => {
    if (!pending || (!disabled && !closeSignal)) return;
    setOpen(false);
    onOpenChange?.(false);
  }, [pending, disabled, closeSignal, onOpenChange]);
  return (
    <div ref={anchor} className={`model-chooser-anchor${open ? " is-open" : ""}`} aria-busy={pending || undefined}>
      <SelectedModelChip
        ref={trigger}
        route={props.selectedRoute}
        expanded={open}
        controlsId={id}
        disabled={disabled}
        onOpen={() => {
          setActivated(true);
          setOpen(!open);
          onOpenChange?.(!open);
        }}
      />
      {activated && Loaded && (
        <Loaded {...props} open={open} setOpen={setOpen} anchorRef={anchor} triggerRef={trigger} dialogId={id} />
      )}
    </div>
  );
}
