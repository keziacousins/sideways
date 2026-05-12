/**
 * Convert theme tokens to CSS variable overrides for the web.
 * Validates values to prevent CSS injection.
 */

function isValidColor(v: string): boolean {
  return /^(#[0-9a-f]{3,8}|rgb\(\s*\d+[\s,]+\d+[\s,]+\d+\s*\)|rgba\(\s*\d+[\s,]+\d+[\s,]+\d+[\s,]+[\d.]+\s*\)|[a-z]{3,20})$/i.test(v.trim());
}

function isValidFont(v: string): boolean {
  return /^[a-zA-Z0-9\s-]+$/.test(v.trim()) && v.length <= 60;
}

/** Map of custom font names to their font file paths (served from /fonts/) */
const CUSTOM_FONTS: Record<string, { regular: string; bold: string; italic?: string; boldItalic?: string }> = {};

function fontFaceRules(fontName: string): string {
  const font = CUSTOM_FONTS[fontName];
  if (!font) return "";
  const rules = [
    `@font-face { font-family: "${fontName}"; src: url("${font.regular}") format("opentype"); font-weight: 400; font-style: normal; }`,
    `@font-face { font-family: "${fontName}"; src: url("${font.bold}") format("opentype"); font-weight: 700; font-style: normal; }`,
  ];
  if (font.italic) rules.push(`@font-face { font-family: "${fontName}"; src: url("${font.italic}") format("opentype"); font-weight: 400; font-style: italic; }`);
  if (font.boldItalic) rules.push(`@font-face { font-family: "${fontName}"; src: url("${font.boldItalic}") format("opentype"); font-weight: 700; font-style: italic; }`);
  return rules.join("\n");
}

export function themeToCSS(tokens: any): string {
  if (!tokens) return "";
  const fontFaces: string[] = [];
  const rules: string[] = [];

  if (tokens.fonts?.display && isValidFont(tokens.fonts.display)) {
    rules.push(`--sw-font-display: "${tokens.fonts.display}", Georgia, serif;`);
    if (tokens.fonts.displayWeight) {
      rules.push(`--sw-font-display-weight: ${tokens.fonts.displayWeight};`);
    }
    const ff = fontFaceRules(tokens.fonts.display);
    if (ff) fontFaces.push(ff);
  }
  if (tokens.fonts?.body && isValidFont(tokens.fonts.body)) {
    rules.push(`--sw-font-body: "${tokens.fonts.body}", system-ui, sans-serif;`);
    const ff = fontFaceRules(tokens.fonts.body);
    if (ff && !fontFaces.includes(ff)) fontFaces.push(ff);
  }
  if (tokens.fonts?.mono && isValidFont(tokens.fonts.mono)) {
    rules.push(`--sw-font-mono: "${tokens.fonts.mono}", ui-monospace, monospace;`);
  }
  if (tokens.colors?.accent && isValidColor(tokens.colors.accent)) {
    rules.push(`--sw-accent: ${tokens.colors.accent};`);
  }

  if (rules.length === 0 && fontFaces.length === 0) return "";
  const varBlock = rules.length > 0 ? `:root { ${rules.join(" ")} }` : "";
  return fontFaces.join("\n") + (fontFaces.length > 0 ? "\n" : "") + varBlock;
}
