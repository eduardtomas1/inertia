/** Start independent privileged-service cleanup together, then await both. */
export async function stopRuntimeAndPrivateConnect(
  stopRuntime: () => Promise<boolean>,
  stopPrivateConnect: () => Promise<void>,
): Promise<boolean> {
  const runtimeStopping = Promise.resolve().then(stopRuntime);
  const privateConnectStopping = Promise.resolve().then(stopPrivateConnect);
  const [runtimeExitConfirmed] = await Promise.all([
    runtimeStopping,
    privateConnectStopping,
  ]);
  return runtimeExitConfirmed;
}
