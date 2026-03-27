/**
 * Convert theme tokens to CSS variable overrides for the web.
 */
export function themeToCSS(tokens: any): string {
  if (!tokens) return "";
  const rules: string[] = [];

  if (tokens.fonts?.display) {
    rules.push(`--sw-font-display: "${tokens.fonts.display}", Georgia, serif;`);
  }
  if (tokens.fonts?.body) {
    rules.push(`--sw-font-body: "${tokens.fonts.body}", system-ui, sans-serif;`);
  }
  if (tokens.fonts?.mono) {
    rules.push(`--sw-font-mono: "${tokens.fonts.mono}", ui-monospace, monospace;`);
  }
  if (tokens.colors?.accent) {
    rules.push(`--sw-accent: ${tokens.colors.accent};`);
  }

  if (rules.length === 0) return "";
  return `:root { ${rules.join(" ")} }`;
}
