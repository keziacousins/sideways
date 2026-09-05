import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../index.js";

const DIAGRAM = "graph TD\n  A[Start] --> B[End]";
const MD = "```mermaid\n" + DIAGRAM + "\n```";

// Stub sidecar. The real one is a headless browser; nothing here needs a
// browser, a container or the network.
const stubSvg = (svg: string) => async () => svg;
const stubFailure = (message: string) => async () => {
  throw new Error(message);
};

// Shaped like what mermaid.render() actually returns: an id-scoped <style>
// block holding the theme (mermaid puts node fill, edge `fill:none` and label
// colour there, NOT on the shapes), class hooks, an empty `style=""` on the
// rect, and the marker the edges point at.
const SVG_ID = "mermaid-d1";
const SVG = `<svg id="${SVG_ID}" width="100%" viewBox="0 0 100 50" style="max-width: 100px;" role="graphics-document document" aria-roledescription="flowchart-v2">
  <style>#${SVG_ID}{font-family:"trebuchet ms",verdana,arial,sans-serif;font-size:16px;fill:#333;}#${SVG_ID} .node rect{fill:#ECECFF;stroke:#9370DB;stroke-width:1px;}#${SVG_ID} .flowchart-link{fill:none;stroke:#333333;}</style>
  <defs><marker id="arrow" markerWidth="8" refX="5" orient="auto"><path d="M0,0 L8,4 L0,8z"/></marker></defs>
  <g class="edges"><path class="edge flowchart-link" d="M0 0L50 25" marker-end="url(#arrow)" stroke="#333" stroke-width="2"/></g>
  <g class="node"><rect class="basic label-container" style="" x="0" y="0" width="40" height="20"/></g>
  <text x="10" y="20" text-anchor="middle" font-size="12px">Start</text>
</svg>`;

// A diagram author's lever on the style block: `themeCSS` is not on mermaid's
// `secure` list, so `%%{init:{"themeCSS":"…"}}%%` in the fence lands here.
// mermaid compiles it through stylis inside the `#<svg-id>{…}` wrapper, so
// anything that comes out unscoped got there by escaping that wrapper.
const svgWithThemeCss = (themeCss: string) =>
  SVG.replace("<style>", `<style>#${SVG_ID}{}${themeCss}`);

describe("mermaid diagrams", () => {
  it("leaves the source in place for the browser on the web target", async () => {
    const html = await renderMarkdown(MD, { target: "web" });
    expect(html).toContain("data-mermaid");
    expect(html).toContain('class="language-mermaid no-highlight"');
    expect(html).toContain(DIAGRAM);
    // no-highlight must actually keep rehype-highlight off the source.
    expect(html).not.toContain("hljs");
  });

  it("emits the source form on the web target even when a renderer is supplied", async () => {
    const html = await renderMarkdown(MD, { target: "web", renderMermaid: stubSvg(SVG) });
    expect(html).toContain("data-mermaid");
    expect(html).not.toContain("<svg");
  });

  it("emits the source form on the pdf target when no renderer is supplied", async () => {
    const html = await renderMarkdown(MD, { target: "pdf" });
    expect(html).toContain("data-mermaid");
    expect(html).not.toContain("<svg");
  });

  it("substitutes pre-rendered SVG on the pdf target", async () => {
    const html = await renderMarkdown(MD, { target: "pdf", renderMermaid: stubSvg(SVG) });
    expect(html).toContain('<figure class="mermaid-diagram">');
    expect(html).toContain("<svg");
    expect(html).toContain('viewBox="0 0 100 50"');
    expect(html).toContain('d="M0 0L50 25"');
    expect(html).toContain('stroke-width="2"');
    expect(html).toContain('text-anchor="middle"');
    expect(html).not.toContain("data-mermaid");
    expect(html).not.toContain("graph TD");
  });

  it("keeps SVG-internal references pointing at the clobber-prefixed ids", async () => {
    const html = await renderMarkdown(MD, { target: "pdf", renderMermaid: stubSvg(SVG) });
    // The sanitiser renames ids; the references have to follow.
    expect(html).toContain('id="user-content-arrow"');
    expect(html).toContain('marker-end="url(#user-content-arrow)"');
  });

  it("falls back to the source form, without throwing, when the renderer rejects", async () => {
    const html = await renderMarkdown("Before\n\n" + MD + "\n\nAfter", {
      target: "pdf",
      renderMermaid: stubFailure("sidecar unreachable"),
    });
    expect(html).toContain("data-mermaid");
    expect(html).toContain('<p class="mermaid-error">');
    expect(html).toContain("sidecar unreachable");
    // The rest of the document still renders.
    expect(html).toContain("<p>Before</p>");
    expect(html).toContain("<p>After</p>");
  });

  it("strips a script element smuggled through the rendered SVG", async () => {
    const html = await renderMarkdown(MD, {
      target: "pdf",
      renderMermaid: stubSvg('<svg><script>alert(1)</script><rect width="1" height="1"/></svg>'),
    });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("<rect");
  });

  it("strips event handlers and off-site links smuggled through the rendered SVG", async () => {
    const html = await renderMarkdown(MD, {
      target: "pdf",
      renderMermaid: stubSvg(
        '<svg onload="alert(1)"><g onclick="alert(2)"><use href="https://evil.example/x"' +
          ' xlink:href="javascript:alert(3)"/></g></svg>',
      ),
    });
    expect(html).not.toContain("onload");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("alert");
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<svg");
  });

  it("strips foreignObject rather than unwrapping its contents", async () => {
    const html = await renderMarkdown(MD, {
      target: "pdf",
      renderMermaid: stubSvg(
        '<svg id="d"><foreignObject><div onclick="alert(1)">smuggled</div></foreignObject>' +
          '<rect width="1" height="1"/></svg>',
      ),
    });
    expect(html).not.toContain("foreignObject");
    expect(html).not.toContain("smuggled");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("<rect");
  });

  it("keeps the diagram's theme CSS, rescoped to the clobber-prefixed id", async () => {
    const html = await renderMarkdown(MD, { target: "pdf", renderMermaid: stubSvg(SVG) });
    // Without this the shapes have no fill at all and print solid black.
    expect(html).toContain("<style>");
    expect(html).toContain(`id="user-content-${SVG_ID}"`);
    expect(html).toContain(`#user-content-${SVG_ID} .node rect{fill:#ECECFF`);
    expect(html).toContain(`#user-content-${SVG_ID} .flowchart-link{fill:none`);
    // The unprefixed selectors would no longer match the renamed element.
    expect(html).not.toContain(`#${SVG_ID} .node`);
  });

  it("drops theme CSS that isn't scoped to the diagram", async () => {
    const html = await renderMarkdown(MD, {
      target: "pdf",
      // A stray `}` ends mermaid's `#<svg-id>{…}` wrapper; everything after it
      // would otherwise be loose CSS over the whole printed document.
      renderMermaid: stubSvg(svgWithThemeCss("}body{display:none}@page{size:A3}")),
    });
    expect(html).not.toContain("display:none");
    expect(html).not.toContain("@page");
    // The diagram's own rules are untouched by the neighbour's bad behaviour.
    expect(html).toContain(`#user-content-${SVG_ID} .node rect{fill:#ECECFF`);
  });

  it("drops theme CSS that would fetch an external resource while printing", async () => {
    const html = await renderMarkdown(MD, {
      target: "pdf",
      renderMermaid: stubSvg(
        svgWithThemeCss(`#${SVG_ID} .node rect{background-image:url("https://evil.example/x")}`),
      ),
    });
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("background-image");
  });

  it("drops theme CSS that tries to close the style element", async () => {
    const html = await renderMarkdown(MD, {
      target: "pdf",
      renderMermaid: stubSvg(
        svgWithThemeCss(`#${SVG_ID}{content:"</style><script>alert(1)</script>"}`),
      ),
    });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("</style><");
  });

  it("drops a style element that isn't inside an svg", async () => {
    const html = await renderMarkdown(MD, {
      target: "pdf",
      renderMermaid: stubSvg('<style>body{display:none}</style><svg id="d"><rect/></svg>'),
    });
    expect(html).not.toContain("<style");
    expect(html).not.toContain("display:none");
    expect(html).toContain("<rect");
  });

  it("leaves other code blocks alone", async () => {
    const html = await renderMarkdown("```typescript\nconst x = 42;\n```", { target: "pdf" });
    expect(html).not.toContain("data-mermaid");
    expect(html).toContain("hljs");
    expect(html).toContain("42");
  });

  it("leaves plain fenced blocks alone", async () => {
    const html = await renderMarkdown("```\nplain text\n```", { target: "web" });
    expect(html).not.toContain("data-mermaid");
    expect(html).toContain("plain text");
  });
});

// A document with several diagrams is the case the PDF budgets were written
// for, so it is the case worth pinning down: the renders have to overlap, and
// the results still have to land back in the right places.
describe("mermaid diagrams (several in one document)", () => {
  const doc = (n: number) =>
    Array.from({ length: n }, (_, i) => "```mermaid\ngraph TD\n  A --> B" + i + "\n```").join("\n\n");

  const indexOf = (code: string) => Number(/B(\d+)/.exec(code)![1]);
  const svgFor = (i: number) =>
    `<svg id="d${i}" width="100%" viewBox="0 0 100 50" style="max-width: 100px;"><text>node-${i}</text></svg>`;

  it("starts every render before awaiting any of them", async () => {
    let inFlight = 0;
    let peak = 0;

    const renderMermaid = async (code: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return svgFor(indexOf(code));
    };

    await renderMarkdown(doc(4), { target: "pdf", renderMermaid });

    // Awaiting one render at a time peaks at 1, which would leave the sidecar
    // client's concurrency limiter inert and spend the per-document deadline
    // serially — the bug this test exists to catch.
    expect(peak).toBe(4);
  });

  it("puts each diagram back in its own place", async () => {
    const html = await renderMarkdown(doc(3), {
      target: "pdf",
      renderMermaid: async (code) => svgFor(indexOf(code)),
    });

    expect(html.indexOf("node-0")).toBeGreaterThan(-1);
    expect(html.indexOf("node-0")).toBeLessThan(html.indexOf("node-1"));
    expect(html.indexOf("node-1")).toBeLessThan(html.indexOf("node-2"));
  });

  it("keeps the rest in place when a failure expands one block into two", async () => {
    const html = await renderMarkdown(doc(3), {
      target: "pdf",
      renderMermaid: async (code) => {
        const i = indexOf(code);
        if (i === 1) throw new Error("diagram 1 is broken");
        return svgFor(i);
      },
    });

    // The failed one degrades to source + note; its neighbours are untouched
    // and still in order around it.
    expect(html).toContain('<p class="mermaid-error">');
    expect(html).toContain("diagram 1 is broken");
    expect(html.indexOf("node-0")).toBeLessThan(html.indexOf("mermaid-error"));
    expect(html.indexOf("mermaid-error")).toBeLessThan(html.indexOf("node-2"));
    expect(html).not.toContain("node-1");
  });
});

// WeasyPrint takes mermaid's width="100%" and ignores the inline max-width
// that is supposed to cap it, so an unmodified diagram is stretched to the
// column width with its labels scaled up to match. The renderer pins the
// natural size from the viewBox instead; the stylesheets only shrink.
describe("mermaid diagram sizing (pdf)", () => {
  const render = (svg: string) =>
    renderMarkdown(MD, { target: "pdf", renderMermaid: stubSvg(svg) });

  it("replaces width=100% with the viewBox's intrinsic size", async () => {
    const html = await render(SVG);
    expect(html).not.toContain('width="100%"');
    expect(html).toContain('width="100"');
    expect(html).toContain('height="50"');
  });

  it("drops the max-width that stood in for the width attribute", async () => {
    const html = await render(SVG);
    expect(html).not.toContain("max-width");
  });

  it("keeps other inline declarations while dropping max-width", async () => {
    const html = await render(
      SVG.replace('style="max-width: 100px;"', 'style="max-width: 100px; background: transparent;"'),
    );
    expect(html).not.toContain("max-width");
    expect(html).toContain("background: transparent");
  });

  it("leaves a diagram alone when the viewBox is missing or unusable", async () => {
    const noViewBox = SVG.replace(' viewBox="0 0 100 50"', "");
    expect(await render(noViewBox)).toContain('width="100%"');

    const zeroWidth = SVG.replace('viewBox="0 0 100 50"', 'viewBox="0 0 0 50"');
    expect(await render(zeroWidth)).toContain('width="100%"');

    const junk = SVG.replace('viewBox="0 0 100 50"', 'viewBox="not a box"');
    expect(await render(junk)).toContain('width="100%"');
  });

  it("still sanitises and rescopes a resized diagram", async () => {
    const html = await render(SVG);
    expect(html).toContain('width="100"');
    expect(html).toContain("#user-content-mermaid-d1");
    expect(html).toContain("url(#user-content-arrow)");
    expect(html).not.toContain("<script");
  });
});
