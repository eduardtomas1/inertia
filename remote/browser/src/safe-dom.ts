export function appendRemoteText(
  parent: HTMLElement,
  value: string,
  className?: string,
): HTMLElement {
  const element = document.createElement("div");
  if (className) element.className = className;
  element.textContent = value;
  parent.append(element);
  return element;
}

export function button(
  label: string,
  action: () => void,
  className?: string,
): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  if (className) element.className = className;
  element.addEventListener("click", action);
  return element;
}
