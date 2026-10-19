"use strict";
document.getElementById("change").addEventListener("click", () => {
  document.getElementById("status").textContent = "Button clicked";
  console.log("fixture button clicked");
});
document.getElementById("confirm").addEventListener("click", () => {
  document.getElementById("confirmed").textContent = confirm("Delete the draft?") ? "Draft deleted" : "Draft kept";
});
console.log("fixture ready");
