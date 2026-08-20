import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  canonicalD,
  createMorph,
  type Morph,
} from "morphicons/dom";
import type { IconInput } from "morphicons/react";
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
  spring?: Parameters<Morph["morphTo"]>[1];
}): React.JSX.Element {
  const [initialPath] = useState(() => canonicalD(icon));
  const pathRef = useRef<SVGPathElement>(null);
  const morphRef = useRef<Morph | null>(null);
  const targetRef = useRef(icon);

  useLayoutEffect(() => {
    const path = pathRef.current;
    if (!path) return;
    const morph = createMorph(path, targetRef.current, {
      reducedMotion: "user",
    });
    morphRef.current = morph;
    return () => {
      morph.destroy();
      if (morphRef.current === morph) morphRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (icon === targetRef.current) return;
    targetRef.current = icon;
    morphRef.current?.morphTo(icon, spring);
  }, [icon, spring]);

  return (
    <span
      className={className
        ? `inertia-morph-icon ${className}`
        : "inertia-morph-icon"}
      data-icon-state={iconState}
      aria-hidden="true"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path ref={pathRef} d={initialPath} />
      </svg>
    </span>
  );
}
