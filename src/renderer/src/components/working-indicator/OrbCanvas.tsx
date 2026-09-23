import { useLayoutEffect, useRef } from "react";
import type {
  OrbDesign,
  WorkingIndicatorSettings,
} from "@shared/working-indicator";
import { sharedOrbLoop } from "./orbEnvironment";
import { orbBleed } from "./orbPaint";
import type { OrbConfig, OrbHandle } from "./orbLoop";

export const ORB_SPEED_FACTORS: Readonly<Record<WorkingIndicatorSettings["speed"], number>> = {
  calm: 0.6,
  normal: 1,
  lively: 1.4,
};

export default function OrbCanvas({
  size,
  design,
  pace,
  settings,
  syncKey = null,
}: {
  syncKey?: string | null;
  size: number;
  design: OrbDesign;
  pace: number;
  settings: Readonly<WorkingIndicatorSettings>;
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handleRef = useRef<OrbHandle | null>(null);
  const config: OrbConfig = {
    design,
    pace,
    speed: ORB_SPEED_FACTORS[settings.speed],
    color: settings.color,
    customColor: settings.customColor,
    glow: settings.glow,
  };
  const configRef = useRef(config);
  configRef.current = config;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handle = sharedOrbLoop().register(canvas, size, configRef.current, syncKey);
    handleRef.current = handle;
    return () => {
      handle.dispose();
      if (handleRef.current === handle) handleRef.current = null;
    };
  }, [size, syncKey]);

  useLayoutEffect(() => {
    handleRef.current?.update(configRef.current);
  }, [design, pace, config.speed, config.color, config.customColor, config.glow]);

  const bleed = orbBleed(size);
  return (
    <canvas
      ref={canvasRef}
      className="working-orb-canvas"
      aria-hidden="true"
      style={{ width: size + bleed * 2, height: size + bleed * 2, left: -bleed, top: -bleed }}
    />
  );
}
