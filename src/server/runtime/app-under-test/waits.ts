export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

export function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true, () => true), delay(ms).then(() => false)]);
}

export function abortion(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Waits for the queued action ahead; its timer and abort listener never outlive the wait. */
export function queueTurn(previous: Promise<void>, ms: number, signal: AbortSignal | undefined): Promise<"ready" | "timeout" | "aborted"> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve("aborted");
      return;
    }
    const finish = (value: "ready" | "timeout" | "aborted"): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = (): void => finish("aborted");
    const timer = setTimeout(() => finish("timeout"), ms);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    previous.then(() => finish("ready"), () => finish("ready"));
  });
}
