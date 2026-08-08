import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import ChatMarkdown from "./ChatMarkdown";

function renderChatMarkdown(text: string): string {
  return renderToStaticMarkup(<ChatMarkdown text={text} cwd={undefined} />);
}

describe("ChatMarkdown LaTeX Math Support", () => {
  it("renders inline LaTeX math expressions using KaTeX", () => {
    const markdown =
      "The temperature difference is $\\Delta T = T_{\\text{final}} - T_{\\text{initial}}$.";
    const html = renderChatMarkdown(markdown);

    expect(html).toContain("katex");
    expect(html).toContain("katex-html");
    expect(html).toContain("Δ");
    expect(html).toContain("T");
  });

  it("renders multiline display/block LaTeX math expressions using KaTeX", () => {
    const markdown = "$$\n\\Delta T = T_{\\text{hot}} - T_{\\text{cold}}\n$$";
    const html = renderChatMarkdown(markdown);

    expect(html).toContain("katex-display");
    expect(html).toContain("katex-html");
    expect(html).toContain("Δ");
  });

  it("renders complex equations with fractions and symbols", () => {
    const markdown =
      "$$\nQ = m \\cdot c \\cdot \\Delta T \\implies \\Delta T = \\frac{Q}{m \\cdot c}\n$$";
    const html = renderChatMarkdown(markdown);

    expect(html).toContain("katex-display");
    expect(html).toContain("mfrac");
    expect(html).toContain("⟹");
  });
});
