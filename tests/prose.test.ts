import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Prose } from "@/components/prose";

const html = (t: string) => renderToStaticMarkup(createElement(Prose, { text: t }));

describe("Prose", () => {
  it("renders headings, paragraphs and lists instead of raw markdown", () => {
    const out = html("Title\n\n## Background\n\nText here.\n\n1. one\n2. two\n\nBut then:\n\n4. four");
    expect(out).not.toContain("##");
    expect(out).toContain('role="heading"');
    expect(out).toMatch(/<ol[^>]*start="1"/);
    expect(out).toMatch(/<ol[^>]*start="4"/);
    expect(out).toContain("<li");
  });

  it("links URLs and markdown links, never interprets HTML", () => {
    const out = html('See [forum](https://forum.cosmos.network/t/1) and https://x.org/a <script>alert(1)</script>');
    expect(out).toContain('href="https://forum.cosmos.network/t/1"');
    expect(out).toContain('href="https://x.org/a"');
    expect(out).not.toContain("<script>");
  });

  it("handles literal \\n sequences and bold", () => {
    const out = html("a\\n\\n**bold** text");
    expect(out).toContain("<strong");
    expect(out).toContain("bold");
  });
});
