/**
 * Validators for theme token values that end up inside a CSS declaration.
 *
 * Theme tokens are attacker-influenced data from the database, interpolated
 * into a <style> block (web) or an inline stylesheet handed to WeasyPrint
 * (print). Every value is checked against an allowlist and a failing value is
 * dropped rather than sanitised — there is no escaping step to get wrong.
 *
 * These live in a shared package because both renderers need the identical
 * rules. They were duplicated once and drifted (the print copy grew hsl()
 * support the web copy never got), which is what this package exists to stop.
 *
 * None of them trim: a validator that checks a different string than the one
 * the caller emits is a hole, and that hole was real — `"Inter\n"` trimmed to
 * a valid "Inter" and was then interpolated with the newline still on it, which
 * is enough to break out of the CSS string. Callers wanting leniency about
 * surrounding whitespace run the value through `trimToken` first and then use
 * that result for *both* the check and the output.
 */

/**
 * Normalise a raw token value to the string that will be emitted, or undefined
 * if there is nothing usable there. Numbers are accepted because weights
 * arrive as either 400 or "400" depending on who wrote the theme JSON.
 */
export function trimToken(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/** A hex, rgb(), rgba(), hsl() or named colour. */
export function isValidColor(v: string): boolean {
  return /^(#[0-9a-f]{3,8}|rgb\(\s*\d+[\s,]+\d+[\s,]+\d+\s*\)|rgba\(\s*\d+[\s,]+\d+[\s,]+\d+[\s,]+[\d.]+\s*\)|hsl\(\s*\d+[\s,]+\d+%[\s,]+\d+%\s*\)|[a-z]{3,20})$/i.test(
    v,
  );
}

/**
 * A font family name, emitted inside a quoted CSS string.
 *
 * Only spaces are allowed as whitespace: a literal newline inside a CSS string
 * is a parse error, and the parser's recovery discards through the end of the
 * rule — which would silently swallow whatever declaration follows.
 */
export function isValidFont(v: string): boolean {
  return /^[a-zA-Z0-9 -]+$/.test(v) && v.length <= 60;
}

/** 1–1000, a keyword, or a variable-font range ("100 1000"). */
export function isValidFontWeight(v: string): boolean {
  const w = "([1-9][0-9]{0,2}|1000)";
  return new RegExp(`^(normal|bold|${w}( +${w})?)$`).test(v);
}

export function isValidFontStyle(v: string): boolean {
  return /^(normal|italic)$/.test(v);
}
