import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import {
  privateConnectConversationIdFromFragment,
  registerPrivateConnectServiceWorker,
} from "./pwa";
import "./styles.css";

// The invitation is a credential-bearing fragment. Remove it before React
// mounts so it cannot become part of navigation state, screenshots, or logs.
const initialPairingFragment = window.location.hash.startsWith("#pair=")
  ? window.location.hash
  : null;
const initialConversationId = privateConnectConversationIdFromFragment(
  window.location.hash,
);
if (initialPairingFragment || initialConversationId) {
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
}
void registerPrivateConnectServiceWorker();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App
      initialPairingFragment={initialPairingFragment}
      initialConversationId={initialConversationId}
    />
  </React.StrictMode>,
);
