/**
 * Convert theme tokens to CSS variable overrides for the web.
 * Validates values to prevent CSS injection.
 */

function isValidColor(v: string): boolean {
  return /^(#[0-9a-f]{3,8}|rgb\(\s*\d+[\s,]+\d+[\s,]+\d+\s*\)|rgba\(\s*\d+[\s,]+\d+[\s,]+\d+[\s,]+[\d.]+\s*\)|[a-z]{3,20})$/i.test(v.trim());
}

function isValidFont(v: string): boolean {
  return /^[a-zA-Z0-9\s\-]+$/.test(v.trim()) && v.length <= 60;
}

export function themeToCSS(tokens: any): string {
  if (!tokens) return "";
  const rules: string[] = [];

  if (tokens.fonts?.display && isValidFont(tokens.fonts.display)) {
    rules.push(`--sw-font-display: "${tokens.fonts.display}", Georgia, serif;`);
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

  if (rules.length === 0) return "";
  return `:root { ${rules.join(" ")} }`;
}
