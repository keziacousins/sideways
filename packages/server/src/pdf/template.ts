/**
 * Builds the full HTML document sent to WeasyPrint for PDF rendering.
 * Supports theme-driven cover pages, typography, and color overrides.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { coverLayouts } from "./covers.js";
import {
  isValidColor,
  isValidFont,
  isValidFontWeight,
  trimToken,
} from "@sideways/theme";

const __dirname = dirname(fileURLToPath(import.meta.url));
const printCSS = readFileSync(join(__dirname, "print.css"), "utf-8");

export interface ThemeTokens {
  logo?: string;
  coverLayout?: string;
  coverSubtitle?: string;
  fonts?: {
    display?: string;
    displayWeight?: string;
    body?: string;
    mono?: string;
  };
  colors?: {
    accent?: string;
    text?: string;
    mutedText?: string;
    rule?: string;
  };
  print?: {
    paperSize?: string;
    headerRight?: string;
    headerLeft?: string;
    footerCenter?: string;
    margins?: string;
    compact?: boolean;
    defaultTitlePage?: boolean;
    defaultToc?: boolean;
  };
}

interface TemplateOptions {
  title: string;
  spaceName: string;
  html: string;
  date: string;
  version?: number;
  showTitlePage?: boolean;
  showToc?: boolean;
  theme?: ThemeTokens;
}

/** Parse rendered HTML for headings to build a TOC */
function extractHeadings(
  html: string,
): { id: string; text: string; level: number }[] {
  const headings: { id: string; text: string; level: number }[] = [];
  const re = /<h([23])\s+id="([^"]+)"[^>]*>(.*?)<\/h[23]>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const text = match[3].replace(/<[^>]+>/g, "").trim();
    headings.push({ level: parseInt(match[1]), text, id: match[2] });
  }
  return headings;
}

/** Validate paper size */
function isValidPaperSize(v: string): boolean {
  return /^(A[0-5]|B[0-5]|letter|legal|ledger|\d+mm\s+\d+mm|\d+in\s+\d+in)$/i.test(v);
}

/** Validate CSS margin value — 1-4 values like "1.5cm 2cm" */
function isValidMargins(v: string): boolean {
  const parts = v.split(/\s+/);
  if (parts.length < 1 || parts.length > 4) return false;
  return parts.every(p => /^\d+(\.\d+)?(cm|mm|in|pt|px)$/.test(p));
}

/** Generate CSS custom properties from theme tokens — print CSS uses these with fallbacks */
function buildThemeCSS(theme: ThemeTokens): string {
  const vars: string[] = [];

  // Each token is trimmed once, then that same string is both validated and
  // emitted. Validating a trimmed copy while emitting the raw value is how
  // "Inter\n" used to reach the stylesheet — see the note in @sideways/theme.
  const add = (
    name: string,
    raw: unknown,
    valid: (v: string) => boolean,
    render: (v: string) => string = (v) => v,
  ) => {
    const v = trimToken(raw);
    if (v && valid(v)) vars.push(`${name}: ${render(v)}`);
  };

  add("--th-font-display", theme.fonts?.display, isValidFont, (v) => `"${v}", Georgia, serif`);
  add("--th-font-display-weight", theme.fonts?.displayWeight, isValidFontWeight);
  add("--th-font-body", theme.fonts?.body, isValidFont, (v) => `"${v}", sans-serif`);
  add("--th-font-mono", theme.fonts?.mono, isValidFont, (v) => `"${v}", monospace`);
  add("--th-color-text", theme.colors?.text, isValidColor);
  add("--th-color-accent", theme.colors?.accent, isValidColor);
  add("--th-color-muted", theme.colors?.mutedText, isValidColor);
  add("--th-color-rule", theme.colors?.rule, isValidColor);
  add("--th-paper-size", theme.print?.paperSize, isValidPaperSize);

  let extra = "";
  const margins = trimToken(theme.print?.margins);
  if (margins && isValidMargins(margins)) {
    extra += `\n@page { margin: ${margins}; }`;
  }

  if (vars.length === 0 && !extra) return "";
  const root = vars.length > 0 ? `\n:root { ${vars.join("; ")}; }` : "";
  return `\n/* Theme tokens */${root}${extra}`;
}

export function buildPrintHTML(options: TemplateOptions): string {
  const {
    title,
    spaceName,
    html,
    date,
    showTitlePage = false,
    showToc = false,
    theme,
  } = options;

  // Replace checkbox inputs with styled spans — WeasyPrint can't render form elements
  const printableHtml = html
    .replace(/<input\s+type="checkbox"\s+checked(?:\s*="")?(?:\s+disabled)?\s*\/?>/gi, '<span class="print-check checked">✓</span> ')
    .replace(/<input\s+type="checkbox"(?:\s+disabled)?\s*\/?>/gi, '<span class="print-check">○</span> ');

  const headings = showToc ? extractHeadings(printableHtml) : [];

  // Cover page: use theme layout if available, otherwise default
  let titlePage = "";
  if (showTitlePage) {
    const layoutName = theme?.coverLayout || "left-aligned";
    const layoutFn = coverLayouts[layoutName] || coverLayouts.centered;
    // The cover layouts interpolate these straight into style attributes, so
    // they get the same allowlist check as the theme CSS above — an invalid
    // value is dropped and the layout falls back to its own default.
    const accent = trimToken(theme?.colors?.accent);
    const displayFont = trimToken(theme?.fonts?.display);
    const displayWeight = trimToken(theme?.fonts?.displayWeight);
    titlePage = layoutFn({
      title,
      spaceName,
      date,
      version: options.version,
      logo: theme?.logo,
      subtitle: theme?.coverSubtitle,
      accent: accent && isValidColor(accent) ? accent : undefined,
      displayFont: displayFont && isValidFont(displayFont) ? displayFont : undefined,
      displayWeight:
        displayWeight && isValidFontWeight(displayWeight) ? displayWeight : undefined,
    });
  }

  const toc =
    showToc && headings.length > 0
      ? `<div class="print-toc">
      <h2>Contents</h2>
      <ul>
        ${headings
          .map(
            (h) =>
              `<li class="toc-h${h.level}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`,
          )
          .join("\n        ")}
      </ul>
    </div>`
      : "";

  // Build CSS: base print styles + theme overrides
  const themeCSS = theme ? buildThemeCSS(theme) : "";
  const isCompact = theme?.print?.compact === true;
  const bodyClass = isCompact ? ' class="compact"' : "";

  // Header-left: inject a hidden element that sets a named string for @page @top-left
  const headerLeftEl = theme?.print?.headerLeft
    ? `<div class="print-header-left-source">${escapeHtml(theme.print.headerLeft)}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>${printCSS}${themeCSS}</style>
</head>
<body${bodyClass}>
  ${headerLeftEl}
  ${titlePage}
  ${toc}
  <div class="print-content">
    ${printableHtml}
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
