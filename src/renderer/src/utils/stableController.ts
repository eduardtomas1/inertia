export function shallowControllerEqual(
  left: object,
  right: object,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) =>
      Object.is(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      ));
}

export type StableActionShape<Actions> = {
  [Key in keyof Actions]: (...arguments_: never[]) => unknown;
};

export function createStableActionProxy<
  Actions extends StableActionShape<Actions>,
>(
  keys: readonly (keyof Actions)[],
  invoke: (key: keyof Actions, arguments_: never[]) => unknown,
): Actions {
  return Object.fromEntries(
    keys.map((key) => [
      key,
      (...arguments_: never[]) => invoke(key, arguments_),
    ]),
  ) as Actions;
}
