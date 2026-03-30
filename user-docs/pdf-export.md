# PDF Export

Export any document as a professionally typeset PDF with cover page and table of contents.

## From the Web

Click the **⋯** menu on any document and select **Download PDF**.

## From the CLI

```bash
sideways export api-design.md
```

Options:
- `-o <path>` — output file path (default: `<slug>.pdf`)
- `--no-toc` — omit table of contents
- `--no-title-page` — omit cover page

## Cover Pages

PDFs include a cover page with:

- Document title
- Space name or custom subtitle
- Document version (e.g. "v5")
- Date
- Logo (if the space has a theme with a logo)

Three built-in cover layouts:
- **left-aligned** (default) — logo top-left, title and metadata below
- **centered** — logo and title centered
- **minimal** — title only with date

## Table of Contents

The TOC is auto-generated from h2 and h3 headings in the document, with page numbers and leader dots.

## Themes in PDF

If the space has a theme assigned, the PDF uses:

- Custom fonts (for headings, body text, and code)
- Custom accent colour (for blockquotes and links)
- Custom cover layout and logo
- Paper size (default: A4)

## What Renders Well

- Headings, paragraphs, lists (including task lists with checkboxes)
- Code blocks with syntax highlighting
- Tables
- Blockquotes
- Math (KaTeX)
- Images
- Wiki-links (rendered as regular links in PDF)

## Limitations

- No flexbox/grid in print layout (WeasyPrint uses block layout)
- Box-drawing characters in code blocks may have vertical gaps depending on font
- Very large documents (100+ pages) may take a few seconds to render
