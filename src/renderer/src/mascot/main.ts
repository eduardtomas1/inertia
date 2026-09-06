import { mountMascot } from "./Mascot";
import "./mascot.css";

const root = document.getElementById("root");
if (root) {
  const dispose = mountMascot(root, window.mascot);
  window.addEventListener("pagehide", dispose, { once: true });
}
