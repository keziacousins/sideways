/**
 * Built-in cover page layouts for PDF export.
 * Each layout is a function that returns HTML for the cover page.
 */

interface CoverOptions {
  title: string;
  spaceName: string;
  date: string;
  version?: number;
  logo?: string;
  subtitle?: string;
  accent?: string;
  displayFont?: string;
  displayWeight?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function logoImg(url: string, maxHeight = "60px"): string {
  return `<img src="${escapeHtml(url)}" style="max-height: ${maxHeight}; max-width: 280px; object-fit: contain;" />`;
}

/** Centered: logo top-center, title large centered, subtitle, date at bottom */
function centered(opts: CoverOptions): string {
  const accent = opts.accent || "#c8a84e";
  return `<div class="cover-centered" style="
    page: title-page;
    page-break-after: always;
    padding: 2.5cm 2cm;
    text-align: center;
    position: relative;
    height: 100vh;
    box-sizing: border-box;
  ">
    <div style="padding-top: 5cm;">
      ${opts.logo ? `<div style="margin-bottom: 2.5cm;">${logoImg(opts.logo, "80px")}</div>` : ""}
      <h1 style="
        font-family: '${opts.displayFont || "Newsreader"}', Georgia, serif;
        font-size: 32pt;
        font-weight: 400;
        color: #1a1a1a;
        margin: 0 0 0.3em;
        letter-spacing: -0.02em;
        line-height: 1.1;
      ">${escapeHtml(opts.title)}</h1>
      ${opts.subtitle ? `<p style="
        font-size: 13pt;
        color: #666;
        margin: 0.5em 0 0;
      ">${escapeHtml(opts.subtitle)}</p>` : `<p style="
        font-size: 13pt;
        color: #666;
        margin: 0.5em 0 0;
      ">${escapeHtml(opts.spaceName)}</p>`}
    </div>
    <div style="position: absolute; bottom: 3cm; left: 0; right: 0; text-align: center;">
      <span style="font-size: 9pt; color: #999;">${opts.version ? `v${opts.version} · ` : ""}${escapeHtml(opts.date)}</span>
    </div>
  </div>`;
}

/** Left-aligned: logo top-left, title + subtitle left-aligned, date at bottom */
function leftAligned(opts: CoverOptions): string {
  return `<div class="cover-left" style="
    page: title-page;
    page-break-after: always;
    padding: 3cm 2.5cm;
    box-sizing: border-box;
  ">
    ${opts.logo ? `<div style="margin-bottom: 2cm;">${logoImg(opts.logo)}</div>` : ""}
    <div style="padding-top: 4cm;">
      <h1 style="
        font-family: '${opts.displayFont || "Newsreader"}', Georgia, serif;
        font-size: 36pt;
        font-weight: 400;
        color: #1a1a1a;
        margin: 0 0 0.4em;
        letter-spacing: -0.02em;
        line-height: 1.1;
        max-width: 85%;
      ">${escapeHtml(opts.title)}</h1>
      ${opts.subtitle ? `<p style="
        font-size: 14pt;
        color: #555;
        margin: 0 0 0.5em;
        max-width: 70%;
      ">${escapeHtml(opts.subtitle)}</p>` : `<p style="
        font-size: 14pt;
        color: #555;
        margin: 0 0 0.5em;
      ">${escapeHtml(opts.spaceName)}</p>`}
      <p style="font-size: 9pt; color: #999; margin: 2em 0 0;">${opts.version ? `v${opts.version} · ` : ""}${escapeHtml(opts.date)}</p>
    </div>
  </div>`;
}

/** Minimal: no logo, title only, thin rule, date small */
function minimal(opts: CoverOptions): string {
  const accent = opts.accent || "#c8a84e";
  return `<div class="cover-minimal" style="
    page: title-page;
    page-break-after: always;
    padding: 2.5cm 2cm;
    padding-top: 8cm;
    position: relative;
    height: 100vh;
    box-sizing: border-box;
  ">
    <h1 style="
      font-family: '${opts.displayFont || "Newsreader"}', Georgia, serif;
      font-size: 28pt;
      font-weight: 400;
      color: #1a1a1a;
      margin: 0 0 0.5em;
      letter-spacing: -0.02em;
      line-height: 1.15;
    ">${escapeHtml(opts.title)}</h1>
    <p style="font-size: 10pt; color: #999; margin: 0;">${escapeHtml(opts.spaceName)} · ${opts.version ? `v${opts.version} · ` : ""}${escapeHtml(opts.date)}</p>
  </div>`;
}

export const coverLayouts: Record<string, (opts: CoverOptions) => string> = {
  centered,
  "left-aligned": leftAligned,
  minimal,
};

export type CoverLayoutName = keyof typeof coverLayouts;
