import type { ActiveAgentPhase } from "../utils/response-timeline/active-state";

const AGENT_PIXEL_GRID_CELLS = Array.from({ length: 9 }, (_, index) => index);

/**
 * The 3x3 "agent is working" glyph. The chat timeline drives it from the
 * active phase; the Work sidebar shows it for running threads with the calmer
 * orbit rhythm, so a running thread reads the same in both places.
 */
export function AgentPixelGrid({
  animated,
  phase,
  rhythm,
}: {
  animated: boolean;
  phase?: ActiveAgentPhase;
  rhythm?: "orbit";
}): React.JSX.Element {
  return (
    <span
      className="agent-pixel-loader"
      aria-hidden="true"
      data-animated={animated ? "true" : "false"}
      data-phase={phase}
      data-rhythm={rhythm}
    >
      {AGENT_PIXEL_GRID_CELLS.map((index) => <span key={index} />)}
    </span>
  );
}
