import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Inertia could not find its application root.");
}
const applicationRoot = root;

async function renderApplication(): Promise<void> {
  const context = await window.inertia.getWindowContext();
  const application = context.role === "detached-chat"
    ? import("./DetachedChatApp").then(({ default: DetachedChatApp }) => (
        <DetachedChatApp initialWindowContext={context} />
      ))
    : import("./App").then(({ default: App }) => <App />);
  createRoot(applicationRoot).render(
    <StrictMode>{await application}</StrictMode>,
  );
}

void renderApplication().catch((error: unknown) => {
  console.error("Inertia could not initialize its renderer", error);
  applicationRoot.replaceChildren();
  const message = document.createElement("p");
  message.className = "renderer-startup-error";
  message.setAttribute("role", "alert");
  message.textContent = "Inertia could not open this window. Close it and try again.";
  applicationRoot.append(message);
});
