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
    const themes = [
      "inertia",
      "grove",
      "ocean",
      "ember",
      "iris",
    ];
    const half = window.localStorage.getItem(`inertia:color-theme:v1:${resolved}`);
    document.documentElement.dataset.colorTheme = themes.includes(half) ? half
      : themes.includes(cachedColorTheme) ? cachedColorTheme : "inertia";
    document.documentElement.style.colorScheme = resolved;
    const custom = JSON.parse(window.localStorage.getItem(`inertia:custom-color:v1:${resolved}`) ?? "null");
    if (custom && /^#[0-9a-f]{6}$/iu.test(custom.color) && custom.tokens && typeof custom.tokens === "object") {
      const tokens = Object.entries(custom.tokens);
      if (tokens.length > 0 && tokens.length <= 64 && tokens.every(([name, value]) =>
        /^[a-z][a-z0-9-]{0,40}$/u.test(name) && typeof value === "string"
        && (/^#[0-9a-f]{6}$/iu.test(value) || /^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, 0\.\d{1,3}\)$/u.test(value)))) {
        const style = document.createElement("style");
        style.id = "inertia-custom-color-theme";
        style.textContent = `:root[data-theme][data-color-theme="custom"]{${tokens.map(([name, value]) => `--${name}:${value};`).join("")}}`;
        document.head.append(style);
        document.documentElement.dataset.colorTheme = "custom";
      }
    }
  } catch {
    // CSS keeps a system-compatible default when renderer storage is blocked.
  }
})();
