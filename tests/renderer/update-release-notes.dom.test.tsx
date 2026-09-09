import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { UpdateReleaseNotes } from "../../src/renderer/src/components/sidebar/UpdateReleaseNotes";

it("formats real release Markdown without navigation, tracking images, raw HTML or executable content", () => {
  const view = render(<UpdateReleaseNotes text={'## Improvements\n\n- **Safe restart:** keeps work safe.\n- [Read more](javascript:alert(1))\n\n![tracker](https://untrusted.invalid/pixel)\n<script>alert(1)</script>\n<iframe src="https://untrusted.invalid"></iframe>'} />);
  expect(screen.getByRole("heading", { name: "Improvements" })).toBeInTheDocument();
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(screen.getByText("Safe restart:").tagName).toBe("STRONG");
  expect(view.container).toHaveTextContent("Read more");
  expect(view.container.querySelector("a, img, script, iframe")).toBeNull();
  expect(view.container).not.toHaveTextContent("alert(1)");
});
