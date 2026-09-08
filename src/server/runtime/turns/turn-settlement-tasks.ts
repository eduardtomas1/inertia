/** Tracks teardown work through its final publication, including rejection. */
export function trackTurnSettlementTask(
  tasks: Set<Promise<void>>,
  value: void | Promise<void> | undefined,
  onSettled: () => void | Promise<void>,
): void {
  if (!value) return;
  const task = Promise.resolve(value)
    .catch(() => undefined)
    .then(async () => {
      try {
        await onSettled();
      } catch {
        // Publication cannot reject a drained lifecycle task. Turn effects
        // supply their own exact-turn durable publication diagnostic.
        console.warn("A runtime settlement snapshot could not be published.");
      }
    })
    .finally(() => { tasks.delete(task); });
  tasks.add(task);
}
