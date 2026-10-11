import type { ComponentPropsWithRef } from "react";

import { TooltipButton } from "./TooltipButton";

export function HintButton({
  hint,
  ...props
}: ComponentPropsWithRef<"button"> & { hint?: string | undefined }): React.JSX.Element {
  return hint
    ? <TooltipButton tooltip={hint} {...props} />
    : <button type="button" {...props} />;
}
