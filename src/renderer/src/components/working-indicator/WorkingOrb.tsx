import { lazy, Suspense } from "react";
import clsx from "clsx";
import type { OrbDesign } from "@shared/working-indicator";
import { useWorkingIndicator } from "./WorkingIndicatorContext";
import "./WorkingOrb.css";

function UnavailableOrb(): React.JSX.Element {
  return <></>;
}

const OrbCanvas = lazy(() => import("./OrbCanvas").catch(() => ({ default: UnavailableOrb })));

export function WorkingOrb({
  size,
  design,
  pace = 1,
  className,
  syncKey = null,
}: {
  syncKey?: string | null;
  size: number;
  design: OrbDesign;
  pace?: number;
  className?: string;
}): React.JSX.Element {
  const settings = useWorkingIndicator();
  return (
    <span
      className={clsx("working-orb", className)}
      aria-hidden="true"
      data-orb-design={design}
      data-orb-pace={pace === 1 ? undefined : pace}
      style={{ width: size, height: size }}
    >
      <Suspense fallback={null}>
        <OrbCanvas size={size} design={design} pace={pace} settings={settings} syncKey={syncKey} />
      </Suspense>
    </span>
  );
}
