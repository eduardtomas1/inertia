import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// The invitation is a credential-bearing fragment. Remove it before React
// mounts so it cannot become part of navigation state, screenshots, or logs.
const initialPairingFragment = window.location.hash.startsWith("#pair=")
  ? window.location.hash
  : null;
if (initialPairingFragment) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App initialPairingFragment={initialPairingFragment} /></React.StrictMode>,
);
