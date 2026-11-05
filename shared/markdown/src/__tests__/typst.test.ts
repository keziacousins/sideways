import { describe, it, expect } from "vitest";
import { renderMarkdown, type TypstDiagram } from "../index.js";

const DIAGRAM = '#canvas({\n  draw.rect((0, 0), (2, 1), name: "a")\n  draw.content("a", [A < B & "C"])\n})';
const MD = "```typst\n" + DIAGRAM + "\n```";

// Stub renderer. The real one is the infra/typst sidecar; nothing here needs it.
const stub = (diagram: TypstDiagram) => {
  const calls: string[] = [];
  const render = async (source: string) => {
    calls.push(source);
    return diagram;
  };
  return { render, calls };
};

describe("typst diagrams", () => {
  it("leaves the fence as a code block when no renderer is supplied", async () => {
    for (const target of ["web", "pdf"] as const) {
      const html = await renderMarkdown(MD, { target });
      expect(html).toContain('class="language-typst"');
      expect(html).not.toContain("typst-diagram");
    }
  });

  it("replaces the fence with an <img> on the web target", async () => {
    const { render } = stub({ src: "/d/space/abc123.svg", width: 240.4, height: 120.6 });
    const html = await renderMarkdown(MD, { target: "web", renderTypst: render });
    expect(html).toContain('<figure class="typst-diagram"><img src="/d/space/abc123.svg" alt="Diagram" width="240" height="121"></figure>');
    expect(html).not.toContain("language-typst");
  });

  it("keeps a data: src on the pdf target, which the sanitiser would strip", async () => {
    const src = "data:image/svg+xml;base64,PHN2Zy8+";
    const { render } = stub({ src });
    const html = await renderMarkdown(MD, { target: "pdf", renderTypst: render });
    expect(html).toContain(`<img src="${src}"`);
  });

  it("hands the renderer the source exactly as written", async () => {
    const { render, calls } = stub({ src: "/d/x.svg" });
    await renderMarkdown(MD, { target: "web", renderTypst: render });
    expect(calls).toEqual([DIAGRAM + "\n"]);
  });

  it("renders every diagram, each in its own place", async () => {
    let n = 0;
    const render = async () => ({ src: `/d/${++n}.svg` });
    const md = `${MD}\n\nBetween.\n\n${MD}`;
    const html = await renderMarkdown(md, { target: "web", renderTypst: render });
    const first = html.indexOf('src="/d/1.svg"');
    const middle = html.indexOf("Between.");
    const second = html.indexOf('src="/d/2.svg"');
    expect(first).toBeGreaterThan(-1);
    expect(middle).toBeGreaterThan(first);
    expect(second).toBeGreaterThan(middle);
  });

  it("falls back to the source and a note when the render fails, without failing the document", async () => {
    const render = async () => {
      throw new Error("line 3, column 3: unknown variable: nonsense");
    };
    const html = await renderMarkdown(`# Title\n\n${MD}\n\nAfter.`, { target: "web", renderTypst: render });
    expect(html).toContain('class="language-typst"');
    expect(html).toContain('<p class="typst-error">Diagram failed to render: line 3, column 3: unknown variable: nonsense</p>');
    expect(html).toContain("After.");
    expect(html).toContain("Title");
  });

  it("escapes the error message rather than interpreting it", async () => {
    const render = async () => {
      throw new Error('<img src=x onerror="alert(1)">');
    };
    const html = await renderMarkdown(MD, { target: "web", renderTypst: render });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&#x3C;img src=x");
  });

  it("leaves other fences alone", async () => {
    const { render, calls } = stub({ src: "/d/x.svg" });
    const md = "```js\nconst a = 1;\n```\n\n```mermaid\ngraph TD\n  A --> B\n```";
    const html = await renderMarkdown(md, { target: "web", renderTypst: render });
    expect(calls).toEqual([]);
    expect(html).toContain("data-mermaid");
    expect(html).not.toContain("typst-diagram");
  });
});
