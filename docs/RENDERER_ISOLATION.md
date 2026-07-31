# Renderer capability blast radius

## Why this document exists

The renderer displays untrusted provider-generated Markdown in the same
JavaScript context that holds the preload bridge (`window.inertia`) and the
runtime WebSocket URL. The sanitizer, CSP, sandbox, and context isolation are all
in place, but a future renderer-content escape would land next to a capability
that can drive the privileged runtime.

This document records what is enforced today, what a stronger isolation boundary
would look like, and why the full refactor was not attempted in the beta
hardening pass.

## Enforced today

**Markdown allowlist.** `ResponseMarkdown` renders through `rehype-raw` followed
by `rehype-sanitize`, in that order, so raw HTML is parsed into the tree and then
filtered. The schema no longer inherits `defaultSchema.tagNames`. It pins an
explicit list (`RESPONSE_MARKDOWN_TAG_NAMES`) and an explicit per-element
attribute map, so a `rehype-sanitize` update cannot silently widen what Inertia
accepts. `script`, `iframe`, `object`, `embed`, `form`, `button`, `style`, `base`,
`link`, `meta`, `svg`, `math`, `template`, and the media elements are all absent.
Event-handler attributes are absent because the attribute map is explicit rather
than additive.

`rehype-raw` was kept deliberately. Provider output uses `<details>`/`<summary>`
for collapsible sections, which is a real product behaviour, and the finding's
requirement — a strict element allowlist — is satisfied by pinning the schema
rather than by removing raw-HTML parsing and rendering the markup as escaped
text. Regression coverage lives in
`tests/renderer/response-markdown-hostile.dom.test.tsx`.

**URL handling.** `resolveResponseLink` classifies every href. Only `http(s)`
becomes an external link (opened through the bridge, never by navigation), only
paths contained within the project root become project links, and everything
else renders as inert text. The sanitizer independently restricts `href`
protocols to `http`, `https`, `mailto` and `src` to `http`, `https`, `data`, so
`javascript:`, `file:`, `vbscript:`, and application schemes such as `inertia:`
cannot survive either layer.

**Content Security Policy.** `src/renderer/index.html` sets
`default-src 'self'`, `script-src 'self'` (no inline execution),
`object-src 'none'`, `base-uri 'self'`, `form-action 'self'`,
`frame-src inertia:`, and `img-src 'self' inertia: data: blob:`. Because
`img-src` omits remote origins, a provider cannot use an image to beacon out
metadata even if a URL survived sanitization.

## Proposed isolation boundary

The transcript surface should not be able to reach the runtime at all.

1. **Move provider transcript rendering into a separate context.** A sandboxed
   `WebContentsView` with no preload, or a sandboxed `<iframe>` served from a
   dedicated internal origin, renders the sanitized Markdown. It receives content
   over `postMessage` and returns only intent messages (for example
   "open this project-relative path", "copy this text").
2. **The untrusted surface receives none of:** the runtime WebSocket URL, the
   preload bridge, Node integration, credential APIs, or project filesystem
   capabilities.
3. **The privileged shell validates every intent** against the same authority it
   already applies to renderer commands, so a compromised transcript surface can
   only ask for actions the user could already take.

## Why the refactor was deferred

Transcript rendering is coupled to the workspace shell in ways that a boundary
change would have to unpick in one pass: virtualization and measurement
(`@tanstack/react-virtual`), xterm and native preview overlays, focus and
keyboard routing, the minimap, streaming updates, and the diff/review surfaces
all share layout and state with the transcript. Splitting the context is a
feature-sized change with real E2E risk, and doing it alongside the remote and
runtime security work in this pass would have made both harder to review.

The interim position is therefore:

- the raw-HTML reduction is implemented now (explicit allowlist, pinned schema,
  hostile-content regression tests);
- this document records the intended boundary;
- renderer authority was **not** expanded anywhere in this pass.

## Narrow runtime-command abstraction

The next preparatory step, so the isolation refactor does not require rewriting
every UI component, is to funnel transcript-originated privileged calls through a
single narrow module instead of calling `window.inertia.*` from components. Today
`ResponseMarkdown` calls `window.inertia.openExternal` and
`window.inertia.openProjectPath` directly. Those two call sites are the complete
transcript-originated privileged surface, and they are the natural seam: replace
them with an injected `transcriptIntents` object, and the same component works
unchanged whether it runs in the privileged renderer or behind `postMessage`.

That seam is intentionally left as the first step of the isolation work rather
than introduced speculatively here, because introducing an abstraction with a
single consumer and no second implementation would be churn without a guarantee.
