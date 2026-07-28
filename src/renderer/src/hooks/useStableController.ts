import { useCallback, useLayoutEffect, useRef } from "react";

import {
  createStableActionProxy,
  shallowControllerEqual,
  type StableActionShape,
} from "../utils/stableController";

export { shallowControllerEqual } from "../utils/stableController";

/**
 * Controller hooks often return object literals whose members are already
 * stable. Retaining the prior envelope prevents unrelated App state from
 * invalidating the full workspace scene.
 */
export function useStableController<Controller extends object>(
  controller: Controller,
): Controller {
  const stableRef = useRef(controller);
  if (!shallowControllerEqual(stableRef.current, controller)) {
    stableRef.current = controller;
  }
  return stableRef.current;
}

/**
 * Exposes one stable callback per named action while always dispatching to the
 * latest render's implementation. This is the same ref-backed event pattern
 * used for long-lived DOM listeners, applied to scene prop boundaries.
 */
export function useStableActions<
  Actions extends StableActionShape<Actions>,
>(
  actions: Actions,
): Actions {
  const latestRef = useRef(actions);
  useLayoutEffect(() => {
    latestRef.current = actions;
  }, [actions]);
  const stableRef = useRef<Actions | null>(null);
  const invoke = useCallback((key: keyof Actions, arguments_: never[]) =>
    latestRef.current[key](...arguments_), []);
  if (!stableRef.current) {
    stableRef.current = createStableActionProxy(
      Object.keys(actions) as (keyof Actions)[],
      invoke,
    );
  }
  return stableRef.current;
}
