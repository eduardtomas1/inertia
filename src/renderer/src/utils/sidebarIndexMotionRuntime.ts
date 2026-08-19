interface RowPosition {
  left: number;
  top: number;
}

interface MotionState {
  animations: Map<string, Animation>;
  positions: Map<string, RowPosition>;
}

const POSITION_EPSILON = 0.75;
const stateByContainer = new WeakMap<HTMLElement, MotionState>();

function motionState(container: HTMLElement): MotionState {
  const current = stateByContainer.get(container);
  if (current) return current;
  const created = {
    animations: new Map<string, Animation>(),
    positions: new Map<string, RowPosition>(),
  };
  stateByContainer.set(container, created);
  return created;
}

export function updateSidebarIndexMotion(container: HTMLElement): void {
  const state = motionState(container);
  const rows = [...container.querySelectorAll<HTMLElement>(
    "[data-sidebar-motion-id]",
  )];
  const containerBounds = container.getBoundingClientRect();
  const nextPositions = new Map<string, RowPosition>();
  for (const row of rows) {
    const identity = row.dataset.sidebarMotionId;
    if (!identity) continue;
    const bounds = row.getBoundingClientRect();
    nextPositions.set(identity, {
      left: bounds.left - containerBounds.left,
      top: bounds.top - containerBounds.top,
    });
  }
  const shell = container.closest<HTMLElement>(".app-shell");
  if (
    state.positions.size > 0
    && document.visibilityState !== "hidden"
    && shell?.dataset.documentVisible !== "false"
  ) {
    for (const row of rows) {
      const identity = row.dataset.sidebarMotionId;
      if (!identity || typeof row.animate !== "function") continue;
      const previous = state.positions.get(identity);
      const next = nextPositions.get(identity);
      if (!previous || !next) continue;
      const deltaX = previous.left - next.left;
      const deltaY = previous.top - next.top;
      if (
        Math.abs(deltaX) < POSITION_EPSILON
        && Math.abs(deltaY) < POSITION_EPSILON
      ) continue;
      state.animations.get(identity)?.cancel();
      const distance = Math.hypot(deltaX, deltaY);
      const animation = row.animate([
        { opacity: 0.86, transform: `translate(${deltaX}px, ${deltaY}px)` },
        { opacity: 1, transform: "translate(0, 0)" },
      ], {
        duration: Math.min(210, 130 + distance * 0.12),
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      });
      state.animations.set(identity, animation);
      for (const event of ["finish", "cancel"]) {
        animation.addEventListener(event, () => {
          if (state.animations.get(identity) === animation) {
            state.animations.delete(identity);
          }
        }, { once: true });
      }
    }
  }
  state.positions = nextPositions;
}

export function cancelSidebarIndexMotion(container: HTMLElement): void {
  const state = stateByContainer.get(container);
  if (!state) return;
  for (const animation of state.animations.values()) animation.cancel();
  stateByContainer.delete(container);
}
