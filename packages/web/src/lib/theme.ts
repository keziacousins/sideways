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

/**
 * Custom web fonts are declared per theme, in the theme's own tokens:
 *
 *   fonts.custom: [
 *     { family: "Example Sans", weight: 400, style: "normal",
 *       src: "/fonts/example/ExampleSans-Regular.woff2" }
 *   ]
 *
 * Theme tokens are attacker-influenced data from the database that ends up
 * inside a <style> block, so every field is checked against an allowlist and
 * a failing entry is dropped rather than sanitised. Font files are served
 * from packages/web/public/fonts/<client>/, populated by
 * scripts/sync-brand-assets.sh — keeping licensed binaries out of the repo.
 */
const MAX_CUSTOM_FONTS = 12;

const FONT_FORMATS: Record<string, string> = {
  woff2: "woff2",
  woff: "woff",
  otf: "opentype",
  ttf: "truetype",
};

interface CustomFont {
  family: string;
  weight?: string | number;
  style?: string;
  src: string;
}

/**
 * Font URLs must be a relative path under /fonts/, with no way to break out
 * of the url() token or the surrounding rule. Anything else is rejected.
 */
function isValidFontSrc(v: string): boolean {
  if (!/^\/fonts\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.(woff2|woff|otf|ttf)$/.test(v)) {
    return false;
  }
  // `..` satisfies the character class above, so exclude traversal explicitly.
  return !v.split("/").includes("..");
}

/** A single weight (400), a keyword, or a variable-font range ("100 900"). */
function isValidFontWeight(v: string): boolean {
  return /^([1-9]00|normal|bold)( [1-9]00)?$/.test(v.trim());
}

function isValidFontStyle(v: string): boolean {
  return /^(normal|italic)$/.test(v.trim());
}

function fontExtension(src: string): string {
  return src.slice(src.lastIndexOf(".") + 1).toLowerCase();
}

/** Build @font-face rules from a theme's declared custom fonts. */
function fontFaceRules(custom: unknown): string[] {
  if (!Array.isArray(custom)) return [];

  const rules: string[] = [];
  for (const entry of custom.slice(0, MAX_CUSTOM_FONTS)) {
    if (!entry || typeof entry !== "object") continue;
    const { family, weight, style, src } = entry as CustomFont;

    if (typeof family !== "string" || !isValidFont(family)) continue;
    if (typeof src !== "string" || !isValidFontSrc(src)) continue;

    // Format comes from the extension we just validated, never from input.
    const format = FONT_FORMATS[fontExtension(src)];
    if (!format) continue;

    const descriptors = [
      `font-family: "${family.trim()}"`,
      `src: url("${src}") format("${format}")`,
    ];

    if (weight !== undefined) {
      const w = String(weight);
      if (!isValidFontWeight(w)) continue;
      descriptors.push(`font-weight: ${w.trim()}`);
    }
    if (style !== undefined) {
      if (typeof style !== "string" || !isValidFontStyle(style)) continue;
      descriptors.push(`font-style: ${style.trim()}`);
    }

    rules.push(`@font-face { ${descriptors.join("; ")}; }`);
  }
  return rules;
}

export function themeToCSS(tokens: any): string {
  if (!tokens) return "";
  const rules: string[] = [];

  if (tokens.fonts?.display && isValidFont(tokens.fonts.display)) {
    rules.push(`--sw-font-display: "${tokens.fonts.display}", Georgia, serif;`);
    if (
      tokens.fonts.displayWeight &&
      isValidFontWeight(String(tokens.fonts.displayWeight))
    ) {
      rules.push(`--sw-font-display-weight: ${tokens.fonts.displayWeight};`);
    }
  }
  if (tokens.fonts?.body && isValidFont(tokens.fonts.body)) {
    rules.push(`--sw-font-body: "${tokens.fonts.body}", system-ui, sans-serif;`);
  }
  if (tokens.fonts?.mono && isValidFont(tokens.fonts.mono)) {
    rules.push(`--sw-font-mono: "${tokens.fonts.mono}", ui-monospace, monospace;`);
  }
  if (tokens.colors?.accent && isValidColor(tokens.colors.accent)) {
    rules.push(`--sw-accent: ${tokens.colors.accent};`);
  }

  const fontFaces = fontFaceRules(tokens.fonts?.custom);

  if (rules.length === 0 && fontFaces.length === 0) return "";
  const varBlock = rules.length > 0 ? `:root { ${rules.join(" ")} }` : "";
  return fontFaces.join("\n") + (fontFaces.length > 0 ? "\n" : "") + varBlock;
}
