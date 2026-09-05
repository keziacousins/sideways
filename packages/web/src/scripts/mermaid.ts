// Client-side Mermaid rendering.
//
// The markdown renderer leaves mermaid fences alone on the web target and
// emits `<pre class="mermaid-diagram" data-mermaid><code>…source…</code></pre>`
// placeholders; only the PDF target pre-rasterises to SVG (WeasyPrint has no
// JS runtime). Drawing in the browser keeps mermaid — which is large — out of
// the critical path: it is pulled in with a dynamic import the first time a
// document that actually contains a diagram is rendered, so diagram-free
// documents download none of it.

// Structurally identical to the config the PDF sidecar uses, with ONE
// deliberate exception: colour. htmlLabels:false is load-bearing for the PDF
// side (WeasyPrint cannot render <foreignObject>) and is kept here so the two
// surfaces lay out the same.
//
// Colour diverges on purpose. Mermaid's stock palette is built for a white
// page; the app is dark, so an unthemed diagram lands as a glaring white slab
// mid-document. The PDF stays on the light palette because it is printed onto
// white paper. Same layout, different colours, each correct for its medium.
const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  htmlLabels: false,
  flowchart: { htmlLabels: false },
} as const;

/**
 * Map the app's design tokens onto mermaid's `base` theme.
 *
 * Read from the live CSS custom properties rather than hardcoded, so this
 * follows whatever `[data-theme]` is in force — including a light theme added
 * later, which then needs no change here. `base` is the theme mermaid provides
 * for exactly this: it derives its remaining shades from what we hand it.
 */
function themeVariables(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string): string =>
    css.getPropertyValue(name).trim() || fallback;

  const surface = token("--sw-ink-light", "#1a1d26");
  const text = token("--sw-text-primary", "#e8e6e1");

  return {
    // Tells mermaid which direction to derive its own shades in. Computed from
    // the actual background rather than the theme's name, so it stays right
    // for any theme we add.
    darkMode: String(isDark(token("--sw-ink-deep", "#0d0f14"))),
    background: token("--sw-ink-deep", "#0d0f14"),
    primaryColor: surface,
    mainBkg: surface,
    secondaryColor: token("--sw-ink-lighter", "#222633"),
    tertiaryColor: token("--sw-ink-surface", "#2a2e3d"),
    primaryTextColor: text,
    textColor: text,
    secondaryTextColor: text,
    tertiaryTextColor: text,
    primaryBorderColor: token("--sw-accent-dim", "#c48a24"),
    lineColor: token("--sw-text-tertiary", "#908b82"),
    noteBkgColor: token("--sw-ink-lighter", "#222633"),
    noteTextColor: token("--sw-text-secondary", "#a8a49b"),
    fontFamily: token("--sw-font-body", "system-ui, sans-serif"),

    // Edge labels get their own backing rect, which `base` leaves black
    // rather than deriving from `background` — a dark smear on the page.
    edgeLabelBackground: token("--sw-ink", "#12141a"),

    // Sequence diagrams do NOT inherit the node colours above: `base` derives
    // actor fill and actor text from different variables, and left to itself
    // it inverts them — light boxes with dark labels sitting next to the dark
    // flowchart nodes. Set them so both diagram types read the same way.
    actorBkg: surface,
    actorBorder: token("--sw-accent-dim", "#c48a24"),
    actorTextColor: text,
    actorLineColor: token("--sw-text-tertiary", "#908b82"),
    signalColor: text,
    signalTextColor: text,
    labelBoxBkgColor: surface,
    labelBoxBorderColor: token("--sw-accent-dim", "#c48a24"),
    labelTextColor: text,
    loopTextColor: text,
    activationBkgColor: token("--sw-ink-lighter", "#222633"),
    activationBorderColor: token("--sw-accent-dim", "#c48a24"),
    sequenceNumberColor: token("--sw-ink-deep", "#0d0f14"),
  };
}

/**
 * Relative luminance of a hex colour, thresholded. Deliberately not a check
 * for `data-theme === "dark"`: a theme we have not written yet should still
 * get the right answer.
 */
function isDark(hex: string): boolean {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return true; // default theme is dark; assume that if unreadable
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}

type Mermaid = (typeof import("mermaid"))["default"];

let mermaidReady: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({ ...MERMAID_CONFIG, theme: "base", themeVariables: themeVariables() });
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
      // Kept so a theme change can redraw from source: mermaid bakes colours
      // into the SVG, so restyling an already-drawn diagram is not possible.
      figure.dataset.mermaidSource = source;
      pre.replaceWith(figure);
    } catch (err) {
      showError(pre, err);
      // Mermaid can leave its scratch element behind when parsing throws.
      document.getElementById(`d${id}`)?.remove();
    }
  }
}

/**
 * Redraw every diagram against the current tokens.
 *
 * Only reachable if something switches `data-theme` at runtime. Nothing does
 * today — the layout hardcodes `dark` — but the diagrams would otherwise be
 * the one part of the page that kept the old palette, so wire it up now
 * rather than leaving a trap for whoever adds the light theme.
 */
async function rethemeDiagrams(): Promise<void> {
  const figures = Array.from(
    document.querySelectorAll<HTMLElement>("figure.mermaid-diagram[data-mermaid-source]"),
  );
  if (figures.length === 0) return;

  const mermaid = await loadMermaid();
  mermaid.initialize({ ...MERMAID_CONFIG, theme: "base", themeVariables: themeVariables() });

  for (const figure of figures) {
    const source = figure.dataset.mermaidSource ?? "";
    if (!source.trim()) continue;
    const id = `mermaid-diagram-${++seq}`;
    try {
      const { svg } = await mermaid.render(id, source);
      figure.innerHTML = svg;
    } catch {
      // The diagram rendered once already, so a failure here is the renderer
      // and not the source. Leave the existing drawing rather than blanking it.
      document.getElementById(`d${id}`)?.remove();
    }
  }
}

if (typeof MutationObserver !== "undefined") {
  new MutationObserver(() => void rethemeDiagrams()).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
}
