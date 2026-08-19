(() => {
  try {
    const themeStyles = document.querySelector("link[data-color-themes]");
    if (themeStyles instanceof HTMLLinkElement) themeStyles.rel = "stylesheet";
    const cached = window.localStorage.getItem("inertia:theme-preference:v1");
    const cachedColorTheme = window.localStorage.getItem("inertia:color-theme:v1");
    const preference = cached === "light" || cached === "dark" || cached === "system"
      ? cached
      : "system";
    const resolved = preference === "system"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : preference;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.colorTheme = [
      "inertia",
      "grove",
      "ocean",
      "ember",
      "iris",
    ].includes(cachedColorTheme) ? cachedColorTheme : "inertia";
    document.documentElement.style.colorScheme = resolved;
  } catch {
    // CSS keeps a system-compatible default when renderer storage is blocked.
  }
})();
