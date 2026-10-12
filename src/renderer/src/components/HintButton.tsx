import type { ComponentPropsWithRef } from "react";

import { TooltipButton } from "./TooltipButton";

export function HintButton({
  hint,
  ...props
}: ComponentPropsWithRef<"button"> & { hint?: string | undefined }): React.JSX.Element {
  return <TooltipButton tooltip={hint ?? ""} {...props} />;
}
