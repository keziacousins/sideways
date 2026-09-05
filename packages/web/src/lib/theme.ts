/**
 * Convert theme tokens to CSS variable overrides for the web.
 * Value validation lives in @sideways/theme, shared with the PDF renderer.
 */

import {
  isValidColor,
  isValidFont,
  isValidFontStyle,
  isValidFontWeight,
  trimToken,
} from "@sideways/theme";

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
 *
 * Extensions are lowercase-only on purpose: sync-brand-assets.sh lowercases
 * them on the way in, so there is exactly one spelling of any given file. On a
 * case-insensitive filesystem, accepting both would let two theme entries point
 * at "different" URLs backed by the same file.
 */
function isValidFontSrc(v: string): boolean {
  if (!/^\/fonts\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.(woff2|woff|otf|ttf)$/.test(v)) {
    return false;
  }
  // `..` satisfies the character class above, so exclude traversal explicitly.
  return !v.split("/").includes("..");
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

    const name = trimToken(family);
    if (!name || !isValidFont(name)) continue;
    if (typeof src !== "string" || !isValidFontSrc(src)) continue;

    // Format comes from the extension we just validated, never from input.
    const format = FONT_FORMATS[fontExtension(src)];
    if (!format) continue;

    const descriptors = [
      `font-family: "${name}"`,
      `src: url("${src}") format("${format}")`,
    ];

    if (weight !== undefined) {
      const w = trimToken(weight);
      if (!w || !isValidFontWeight(w)) continue;
      descriptors.push(`font-weight: ${w}`);
    }
    if (style !== undefined) {
      const st = trimToken(style);
      if (!st || !isValidFontStyle(st)) continue;
      descriptors.push(`font-style: ${st}`);
    }

    rules.push(`@font-face { ${descriptors.join("; ")}; }`);
  }
  return rules;
}

export function themeToCSS(tokens: any): string {
  if (!tokens) return "";
  const rules: string[] = [];

  // Every branch below validates and emits the same trimmed string — see the
  // note in @sideways/theme about why those must not be allowed to diverge.
  const display = trimToken(tokens.fonts?.display);
  if (display && isValidFont(display)) {
    rules.push(`--sw-font-display: "${display}", Georgia, serif;`);
    const weight = trimToken(tokens.fonts?.displayWeight);
    if (weight && isValidFontWeight(weight)) {
      rules.push(`--sw-font-display-weight: ${weight};`);
    }
  }
  const body = trimToken(tokens.fonts?.body);
  if (body && isValidFont(body)) {
    rules.push(`--sw-font-body: "${body}", system-ui, sans-serif;`);
  }
  const mono = trimToken(tokens.fonts?.mono);
  if (mono && isValidFont(mono)) {
    rules.push(`--sw-font-mono: "${mono}", ui-monospace, monospace;`);
  }
  const accent = trimToken(tokens.colors?.accent);
  if (accent && isValidColor(accent)) {
    rules.push(`--sw-accent: ${accent};`);
  }

  const fontFaces = fontFaceRules(tokens.fonts?.custom);

  if (rules.length === 0 && fontFaces.length === 0) return "";
  const varBlock = rules.length > 0 ? `:root { ${rules.join(" ")} }` : "";
  return fontFaces.join("\n") + (fontFaces.length > 0 ? "\n" : "") + varBlock;
}
