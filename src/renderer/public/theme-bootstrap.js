(() => {
  try {
    const cached = window.localStorage.getItem("inertia:theme-preference:v1");
    const preference = cached === "light" || cached === "dark" || cached === "system"
      ? cached
      : "system";
    const resolved = preference === "system"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : preference;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  } catch {
    // CSS keeps a system-compatible default when renderer storage is blocked.
  }
})();
