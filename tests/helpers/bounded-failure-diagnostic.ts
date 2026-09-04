export type BoundedFailureDiagnostic<T> =
  | { readonly outcome: "captured"; readonly value: T }
  | { readonly outcome: "failed" }
  | { readonly outcome: "timed-out" };

export async function captureBoundedFailureDiagnostic<T>(
  capture: () => Promise<T>,
  timeoutMs: number,
): Promise<BoundedFailureDiagnostic<T>> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const operation = Promise.resolve().then(capture).then(
    (value): BoundedFailureDiagnostic<T> => ({ outcome: "captured", value }),
    (): BoundedFailureDiagnostic<T> => ({ outcome: "failed" }),
  );
  const deadline = new Promise<BoundedFailureDiagnostic<T>>((resolve) => {
    timeout = setTimeout(
      () => resolve({ outcome: "timed-out" }),
      Math.max(1, Math.trunc(timeoutMs)),
    );
    timeout.unref();
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
