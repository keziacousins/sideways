// Client-side Mermaid rendering.
//
// The markdown renderer leaves mermaid fences alone on the web target and
// emits `<pre class="mermaid-diagram" data-mermaid><code>…source…</code></pre>`
// placeholders; only the PDF target pre-rasterises to SVG (WeasyPrint has no
// JS runtime). Drawing in the browser keeps mermaid — which is large — out of
// the critical path: it is pulled in with a dynamic import the first time a
// document that actually contains a diagram is rendered, so diagram-free
// documents download none of it.

// Must stay identical to the config the PDF sidecar uses, or the two surfaces
// drift. htmlLabels:false is load-bearing for the PDF side (WeasyPrint cannot
// render <foreignObject>) and is kept here so both look the same.
const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  htmlLabels: false,
  flowchart: { htmlLabels: false },
} as const;

type Mermaid = (typeof import("mermaid"))["default"];

let mermaidReady: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize(MERMAID_CONFIG);
      return mermaid;
    });
  }
  return mermaidReady;
}

// Render ids have to be unique for the lifetime of the page — the editor
// preview re-renders the same diagrams over and over.
let seq = 0;

// A diagram that will not parse must never blank the block or take the rest
// of the page down with it: keep the source visible and say why, quietly.
function showError(pre: HTMLElement, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const note = document.createElement("p");
  note.className = "mermaid-error";
  note.textContent = `Diagram not rendered: ${message.split("\n")[0]}`;
  pre.insertAdjacentElement("afterend", note);
}

export async function renderMermaidDiagrams(root: ParentNode = document): Promise<void> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("pre[data-mermaid]"));
  if (blocks.length === 0) return; // nothing to draw — mermaid is never fetched

  const mermaid = await loadMermaid();

  for (const pre of blocks) {
    // Claim the node: two passes can overlap (an editor preview firing while
    // mermaid is still downloading), and both would be holding this block.
    if (pre.dataset.mermaid === undefined) continue;
    delete pre.dataset.mermaid;
    const source = pre.querySelector("code")?.textContent ?? "";
    if (!source.trim()) continue;

    const id = `mermaid-diagram-${++seq}`;
    try {
      const { svg } = await mermaid.render(id, source);
      const figure = document.createElement("figure");
      figure.className = "mermaid-diagram";
      figure.innerHTML = svg;
      pre.replaceWith(figure);
    } catch (err) {
      showError(pre, err);
      // Mermaid can leave its scratch element behind when parsing throws.
      document.getElementById(`d${id}`)?.remove();
    }
  }
}
