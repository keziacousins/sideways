import { describe, it, expect } from "vitest";
import { themeToCSS } from "../theme.js";

/**
 * Theme tokens come from the database and are injected into a <style> block,
 * so the validation here is a security boundary, not just tidiness. Every
 * "rejects" case below is an escape attempt out of the value it sits in.
 */
describe("themeToCSS", () => {
  it("returns empty string for missing or empty tokens", () => {
    expect(themeToCSS(null)).toBe("");
    expect(themeToCSS(undefined)).toBe("");
    expect(themeToCSS({})).toBe("");
  });

  describe("font family and colour variables", () => {
    it("emits variables for display, body and mono families", () => {
      const css = themeToCSS({
        fonts: { display: "Newsreader", body: "Inter", mono: "Fira Code" },
      });
      expect(css).toContain('--sw-font-display: "Newsreader", Georgia, serif;');
      expect(css).toContain('--sw-font-body: "Inter", system-ui, sans-serif;');
      expect(css).toContain('--sw-font-mono: "Fira Code", ui-monospace, monospace;');
    });

    it("emits a valid accent colour", () => {
      expect(themeToCSS({ colors: { accent: "#9B81F5" } })).toContain(
        "--sw-accent: #9B81F5;",
      );
    });

    it("rejects a family name carrying a quote escape", () => {
      const css = themeToCSS({ fonts: { body: 'Inter", x: url(evil)' } });
      expect(css).toBe("");
    });

    it("rejects a colour carrying extra declarations", () => {
      const css = themeToCSS({ colors: { accent: "red; } body { display: none } :root {" } });
      expect(css).toBe("");
    });

    it("rejects a display weight carrying extra declarations", () => {
      const css = themeToCSS({
        fonts: { display: "Inter", displayWeight: "500; } body { display: none } :root {" },
      });
      expect(css).toContain("--sw-font-display:");
      expect(css).not.toContain("display: none");
      expect(css).not.toContain("--sw-font-display-weight");
    });

    it("accepts a valid display weight", () => {
      expect(themeToCSS({ fonts: { display: "Inter", displayWeight: "500" } })).toContain(
        "--sw-font-display-weight: 500;",
      );
    });
  });

  describe("custom @font-face rules", () => {
    const font = (over: Record<string, unknown> = {}) => ({
      fonts: {
        custom: [
          {
            family: "Example Sans",
            weight: 400,
            style: "normal",
            src: "/fonts/example/ExampleSans-Regular.woff2",
            ...over,
          },
        ],
      },
    });

    it("emits a rule for a valid entry", () => {
      const css = themeToCSS(font());
      expect(css).toContain(
        '@font-face { font-family: "Example Sans"; ' +
          'src: url("/fonts/example/ExampleSans-Regular.woff2") format("woff2"); ' +
          "font-weight: 400; font-style: normal; }",
      );
    });

    it("derives the format from the file extension", () => {
      const cases: [string, string][] = [
        ["woff2", "woff2"],
        ["woff", "woff"],
        ["otf", "opentype"],
        ["ttf", "truetype"],
      ];
      for (const [ext, format] of cases) {
        const css = themeToCSS(font({ src: `/fonts/example/Example.${ext}` }));
        expect(css).toContain(`format("${format}")`);
      }
    });

    it("emits rules even when no other tokens are set", () => {
      expect(themeToCSS(font())).toContain("@font-face");
    });

    it("accepts a variable-font weight range", () => {
      expect(themeToCSS(font({ weight: "100 900" }))).toContain("font-weight: 100 900;");
      // Real ranges are not all multiples of 100 — Roboto Flex ships 100–1000.
      expect(themeToCSS(font({ weight: "100 1000" }))).toContain("font-weight: 100 1000;");
      expect(themeToCSS(font({ weight: 350 }))).toContain("font-weight: 350;");
      expect(themeToCSS(font({ weight: 1 }))).toContain("font-weight: 1;");
      expect(themeToCSS(font({ weight: "bold" }))).toContain("font-weight: bold;");
    });

    it("omits weight and style when not supplied", () => {
      const css = themeToCSS(font({ weight: undefined, style: undefined }));
      expect(css).toContain('font-family: "Example Sans"');
      expect(css).not.toContain("font-weight");
      expect(css).not.toContain("font-style");
    });

    it("rejects a src that escapes the url() token", () => {
      const attacks = [
        '/fonts/x/a.woff2") format("woff2"); } body { display: none } @font-face { src: url("x',
        "/fonts/x/a.woff2'); } body { display: none } @font-face { src: url('x",
        "/fonts/x/a.woff2); } body { display: none",
      ];
      for (const src of attacks) {
        expect(themeToCSS(font({ src }))).toBe("");
      }
    });

    it("rejects a src outside /fonts/", () => {
      const attacks = [
        "https://evil.example.com/a.woff2",
        "//evil.example.com/a.woff2",
        "data:font/woff2;base64,AAAA",
        "/etc/passwd.woff2",
        "/assets/x/a.woff2",
      ];
      for (const src of attacks) {
        expect(themeToCSS(font({ src }))).toBe("");
      }
    });

    it("rejects path traversal in a src", () => {
      expect(themeToCSS(font({ src: "/fonts/../secret.woff2" }))).toBe("");
      expect(themeToCSS(font({ src: "/fonts/x/../../secret.woff2" }))).toBe("");
    });

    it("rejects an unknown font extension", () => {
      expect(themeToCSS(font({ src: "/fonts/example/Example.svg" }))).toBe("");
      expect(themeToCSS(font({ src: "/fonts/example/Example.js" }))).toBe("");
    });

    it("rejects an invalid family, weight or style", () => {
      expect(themeToCSS(font({ family: 'Bad"; } body { display: none } @font-face { x: "' }))).toBe("");
      expect(themeToCSS(font({ weight: "400; } body { display: none } :root {" }))).toBe("");
      expect(themeToCSS(font({ style: "normal; } body { display: none } :root {" }))).toBe("");
      expect(themeToCSS(font({ weight: 0 }))).toBe("");
      expect(themeToCSS(font({ weight: 1001 }))).toBe("");
      expect(themeToCSS(font({ weight: -400 }))).toBe("");
    });

    it("rejects a family name containing a newline", () => {
      // A raw newline inside a CSS string is a parse error, and the parser
      // recovers by discarding through the end of the rule — which would take
      // whatever declaration follows with it.
      expect(themeToCSS(font({ family: "Example\nSans" }))).toBe("");
      expect(themeToCSS({ fonts: { body: "Inter\r\n} :root { display: none" } })).toBe("");
    });

    it("normalises surrounding whitespace instead of emitting it", () => {
      // The value that gets validated has to be the value that gets emitted:
      // trimming only inside the validator let "Inter\n" through as "Inter".
      const css = themeToCSS({ fonts: { body: "  Inter\n" } });
      expect(css).toContain('--sw-font-body: "Inter", system-ui, sans-serif;');
      expect(css).not.toContain("\n\"");
      expect(themeToCSS(font({ family: " Example Sans " }))).toContain(
        'font-family: "Example Sans"',
      );
    });

    it("rejects an uppercase file extension", () => {
      // sync-brand-assets.sh lowercases extensions, so /fonts/x/A.WOFF2 is a
      // URL that cannot exist. See isValidFontSrc.
      expect(themeToCSS(font({ src: "/fonts/example/Example.WOFF2" }))).toBe("");
    });

    it("drops only the invalid entries, keeping valid ones", () => {
      const css = themeToCSS({
        fonts: {
          custom: [
            { family: "Good Sans", src: "/fonts/example/Good.woff2" },
            { family: "Bad Sans", src: "javascript:alert(1)" },
          ],
        },
      });
      expect(css).toContain('font-family: "Good Sans"');
      expect(css).not.toContain("Bad Sans");
    });

    it("caps the number of rules emitted", () => {
      const custom = Array.from({ length: 30 }, (_, i) => ({
        family: `Family ${i}`,
        src: `/fonts/example/Font${i}.woff2`,
      }));
      const css = themeToCSS({ fonts: { custom } });
      expect(css.match(/@font-face/g)).toHaveLength(12);
    });

    it("ignores a custom value that is not an array of objects", () => {
      expect(themeToCSS({ fonts: { custom: "not-an-array" } })).toBe("");
      expect(themeToCSS({ fonts: { custom: [null, 42, "x"] } })).toBe("");
    });
  });
});
