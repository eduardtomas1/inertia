const reversalTails = new Map<string, Promise<void>>();

export async function withReversalRepositoryLock<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = reversalTails.get(root) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  reversalTails.set(root, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (reversalTails.get(root) === tail) reversalTails.delete(root);
  }
}
