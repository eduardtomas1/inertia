import clsx from "clsx";
import {
  MorphIcon,
  type IconInput,
  type MorphIconProps,
} from "morphicons/react";
import "./InertiaMorphIcon.css";

export function InertiaMorphIcon({
  icon,
  iconState,
  size,
  strokeWidth = 2,
  className,
  spring = "snappy",
}: {
  icon: IconInput;
  iconState: string;
  size: number;
  strokeWidth?: number;
  className?: string;
  spring?: MorphIconProps["spring"];
}): React.JSX.Element {
  return (
    <span
      className={clsx("inertia-morph-icon", className)}
      data-icon-state={iconState}
      aria-hidden="true"
    >
      <MorphIcon
        icon={icon}
        size={size}
        strokeWidth={strokeWidth}
        spring={spring}
        reducedMotion="user"
      />
    </span>
  );
}
