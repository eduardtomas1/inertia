export function afterSmoothScroll(
  element: HTMLElement,
  callback: () => void,
  fallbackMs = 900,
): () => void {
  let settled = false;
  const detach = (): void => {
    settled = true;
    element.removeEventListener("scrollend", finish);
    window.clearTimeout(timer);
  };
  function finish(): void {
    if (settled) return;
    detach();
    callback();
  }
  const timer = window.setTimeout(finish, fallbackMs);
  element.addEventListener("scrollend", finish);
  return detach;
}
