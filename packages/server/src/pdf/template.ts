/**
 * Builds the full HTML document sent to WeasyPrint for PDF rendering.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const printCSS = readFileSync(join(__dirname, "print.css"), "utf-8");

interface TemplateOptions {
  title: string;
  spaceName: string;
  html: string;
  date: string;
  showTitlePage?: boolean;
  showToc?: boolean;
}

/** Parse rendered HTML for headings to build a TOC */
function extractHeadings(
  html: string,
): { id: string; text: string; level: number }[] {
  const headings: { id: string; text: string; level: number }[] = [];
  const re = /<h([23])\s+id="([^"]+)"[^>]*>(.*?)<\/h[23]>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    // Strip inner HTML tags (autolink wrappers etc)
    const text = match[3].replace(/<[^>]+>/g, "").trim();
    headings.push({ level: parseInt(match[1]), text, id: match[2] });
  }
  return headings;
}

export function buildPrintHTML(options: TemplateOptions): string {
  const {
    title,
    spaceName,
    html,
    date,
    showTitlePage = false,
    showToc = false,
  } = options;

  // Replace checkbox inputs with styled spans — WeasyPrint can't render form elements
  const printableHtml = html
    .replace(/<input\s+type="checkbox"\s+checked(?:\s*="")?(?:\s+disabled)?\s*\/?>/gi, '<span class="print-check checked">✓</span> ')
    .replace(/<input\s+type="checkbox"(?:\s+disabled)?\s*\/?>/gi, '<span class="print-check">○</span> ');

  const headings = showToc ? extractHeadings(printableHtml) : [];

  const titlePage = showTitlePage
    ? `<div class="print-title-page">
      <h1>${escapeHtml(title)}</h1>
      <div class="print-rule"></div>
      <p class="print-subtitle">${escapeHtml(spaceName)}</p>
      <div class="print-meta">
        <span>${escapeHtml(date)}</span>
      </div>
    </div>`
    : "";

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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>${printCSS}</style>
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
