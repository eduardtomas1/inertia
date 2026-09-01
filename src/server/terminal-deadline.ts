/** Resolves false if an asynchronous shutdown proof misses its deadline. */
export async function beforeTerminalDeadline(
  operation: Promise<boolean>,
  deadlineAt: number,
): Promise<boolean> {
  type Settlement =
    | { kind: "pending" }
    | { kind: "settled"; value: boolean };
  const settlement: { current: Settlement } = { current: { kind: "pending" } };
  const observedSettlement = (): Settlement => settlement.current;
  void operation.then(
    (value) => { settlement.current = { kind: "settled", value }; },
    () => { settlement.current = { kind: "settled", value: false }; },
  );
  await Promise.resolve();
  const immediate = observedSettlement();
  if (immediate.kind === "settled") return immediate.value;
  const remainingMs = Math.trunc(deadlineAt - Date.now());
  if (remainingMs <= 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const delayed = observedSettlement();
    return delayed.kind === "settled"
      ? delayed.value
      : false;
  }
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), remainingMs);
    timer.unref();
    void operation.then(finish, () => finish(false));
  });
}
