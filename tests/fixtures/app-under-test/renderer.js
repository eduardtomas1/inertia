"use strict";
document.getElementById("change").addEventListener("click", () => {
  document.getElementById("status").textContent = "Button clicked";
  console.log("fixture button clicked");
});
document.getElementById("confirm").addEventListener("click", () => {
  document.getElementById("confirmed").textContent = confirm("Delete the draft?") ? "Draft deleted" : "Draft kept";
});
// Synthesized keyboard and wheel input (native windows) shows up here.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  document.getElementById("status").textContent = "Escape pressed";
  console.log("fixture escape pressed");
});
window.addEventListener("wheel", (event) => {
  if (event.deltaY <= 0) return;
  document.getElementById("status").textContent = "Wheel scrolled down";
}, { passive: true });
console.log("fixture ready");
