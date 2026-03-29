/**
 * Builds the full HTML document sent to WeasyPrint for PDF rendering.
 * Supports theme-driven cover pages, typography, and color overrides.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { coverLayouts } from "./covers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const printCSS = readFileSync(join(__dirname, "print.css"), "utf-8");

export interface ThemeTokens {
  logo?: string;
  coverLayout?: string;
  coverSubtitle?: string;
  fonts?: {
    display?: string;
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
    footerCenter?: string;
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

/** Validate a CSS color value — hex, rgb(), hsl(), or named colors */
function isValidColor(v: string): boolean {
  return /^(#[0-9a-f]{3,8}|rgb\(\s*\d+[\s,]+\d+[\s,]+\d+\s*\)|rgba\(\s*\d+[\s,]+\d+[\s,]+\d+[\s,]+[\d.]+\s*\)|hsl\(\s*\d+[\s,]+\d+%[\s,]+\d+%\s*\)|[a-z]{3,20})$/i.test(v.trim());
}

/** Validate a font family name — alphanumeric, spaces, hyphens only */
function isValidFont(v: string): boolean {
  return /^[a-zA-Z0-9\s\-]+$/.test(v.trim()) && v.length <= 60;
}

/** Validate paper size */
function isValidPaperSize(v: string): boolean {
  return /^(A[0-5]|B[0-5]|letter|legal|ledger|\d+mm\s+\d+mm|\d+in\s+\d+in)$/i.test(v.trim());
}

/** Generate CSS overrides from theme tokens */
function buildThemeCSS(theme: ThemeTokens): string {
  const rules: string[] = [];

  // Font overrides (validated against injection)
  if (theme.fonts?.body && isValidFont(theme.fonts.body)) {
    rules.push(`body { font-family: "${theme.fonts.body}", sans-serif; }`);
  }
  if (theme.fonts?.display && isValidFont(theme.fonts.display)) {
    const df = `"${theme.fonts.display}"`;
    rules.push(`h1, h2, h3, h4, h5, h6 { font-family: ${df}, Georgia, serif; }`);
    rules.push(`.print-title-page h1, .cover-centered h1, .cover-left h1, .cover-minimal h1 { font-family: ${df}, Georgia, serif; }`);
    rules.push(`.print-toc h2 { font-family: ${df}, Georgia, serif; }`);
  }
  if (theme.fonts?.mono && isValidFont(theme.fonts.mono)) {
    rules.push(`code, pre, kbd { font-family: "${theme.fonts.mono}", monospace; }`);
  }

  // Color overrides (validated)
  if (theme.colors?.text && isValidColor(theme.colors.text)) {
    rules.push(`body { color: ${theme.colors.text}; }`);
  }
  if (theme.colors?.accent && isValidColor(theme.colors.accent)) {
    rules.push(`a { color: ${theme.colors.accent}; }`);
    rules.push(`blockquote { border-left-color: ${theme.colors.accent}; }`);
    rules.push(`.print-rule { background: ${theme.colors.accent}; }`);
  }
  if (theme.colors?.rule && isValidColor(theme.colors.rule)) {
    rules.push(`h1, h2 { border-bottom-color: ${theme.colors.rule}; }`);
    rules.push(`hr { border-color: ${theme.colors.rule}; }`);
  }

  // Paper size override (validated)
  if (theme.print?.paperSize && isValidPaperSize(theme.print.paperSize)) {
    rules.push(`@page { size: ${theme.print.paperSize}; }`);
  }

  if (rules.length === 0) return "";
  return `\n/* Theme overrides */\n${rules.join("\n")}`;
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
    titlePage = layoutFn({
      title,
      spaceName,
      date,
      version: options.version,
      logo: theme?.logo,
      subtitle: theme?.coverSubtitle,
      accent: theme?.colors?.accent,
      displayFont: theme?.fonts?.display,
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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>${printCSS}${themeCSS}</style>
</head>
<body>
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
