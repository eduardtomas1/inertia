import { useId, useLayoutEffect } from "react";

import { setNativePreviewSuspension } from "../utils/nativePreviewOverlay";

export function useNativePreviewSuspension(active: boolean): void {
  const id = useId();

  useLayoutEffect(() => {
    setNativePreviewSuspension(id, active);
    return () => setNativePreviewSuspension(id, false);
  }, [active, id]);
}
