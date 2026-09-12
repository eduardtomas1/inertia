import ReactMarkdown from "react-markdown";

// Reuse the existing parser, but without chat tools, raw HTML, images or links.
// Only the separate main-authored release-page action can open a URL.
export function UpdateReleaseNotes({ text }: { text: string }): React.JSX.Element {
  return <ReactMarkdown skipHtml unwrapDisallowed allowedElements={[
    "p", "ul", "ol", "li", "strong", "em", "code", "pre", "blockquote",
    "h1", "h2", "h3", "h4", "h5", "h6", "br", "hr",
  ]}>{text}</ReactMarkdown>;
}
