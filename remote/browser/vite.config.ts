import { resolve } from "node:path";

import { defineConfig } from "vite";

import remoteComponentVersions from "../component-versions.json" with {
  type: "json",
};

export const REMOTE_BROWSER_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src ws: wss:",
    "img-src 'none'",
    "font-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
  ].join("; "),
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

export default defineConfig({
  plugins: [{
    name: "inertia-remote-browser-version",
    transformIndexHtml(html) {
      return html.replaceAll(
        "__REMOTE_BROWSER_VERSION__",
        remoteComponentVersions.browser,
      );
    },
  }],
  root: resolve(import.meta.dirname),
  publicDir: false,
  server: {
    host: "127.0.0.1",
    headers: REMOTE_BROWSER_HEADERS,
    fs: {
      allow: [resolve(import.meta.dirname, "../..")],
    },
  },
  preview: {
    host: "127.0.0.1",
    headers: REMOTE_BROWSER_HEADERS,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
});
