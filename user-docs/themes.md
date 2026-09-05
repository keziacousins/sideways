# Themes

Themes customise the visual appearance of a space — fonts, colors, cover pages, and logos — for both web display and PDF export.

## Default Theme

Without a theme, Sideways uses the house style:

- **Headings**: Newsreader (serif)
- **Body**: Inter (sans-serif)
- **Code**: Fira Code (monospace)
- **Accent**: Gold (#c8a84e)
- **Cover layout**: Left-aligned

## Assigning a Theme

Go to **Space Settings** → **Theme** and select from available themes.

Themes are created via the API (a theme management UI is planned).

## Theme Tokens

A theme is a JSON object with these properties:

```json
{
  "logo": "/api/themes/{id}/logo",
  "coverLayout": "left-aligned",
  "coverSubtitle": "Engineering Documentation",
  "fonts": {
    "display": "Georgia",
    "displayWeight": "500",
    "body": "Georgia",
    "mono": "Fira Code"
  },
  "colors": {
    "accent": "#2563eb"
  },
  "print": {
    "paperSize": "A4"
  }
}
```

All fields are optional — unset fields fall back to the default Sideways theme.

### Fonts

| Token | Affects | Default |
|-------|---------|---------|
| `fonts.display` | Headings (h1-h6), cover title, TOC | Newsreader |
| `fonts.displayWeight` | Heading font weight | 500 |
| `fonts.body` | Body text, UI elements | Inter |
| `fonts.mono` | Code blocks, inline code | Fira Code |

`fonts.display`, `fonts.body` and `fonts.mono` name a family. For anything
beyond the built-in families, the font also has to be delivered — see
[Custom fonts](#custom-fonts) below.

### Colors

| Token | Affects | Default |
|-------|---------|---------|
| `colors.accent` | Links, blockquote borders, UI accents | #c8a84e (gold) |
| `colors.text` | Body text color (print) | #1a1a1a |
| `colors.mutedText` | Secondary text (print) | #666 |
| `colors.rule` | Horizontal rules (print) | #e0e0e0 |

### Cover Page

| Token | Affects |
|-------|---------|
| `coverLayout` | Cover style: `left-aligned`, `centered`, or `minimal` |
| `coverSubtitle` | Text below the title (defaults to space name) |
| `logo` | URL to logo image (uploaded via theme API; PNG, JPEG, GIF or WebP — **not SVG**) |

### Print

| Token | Affects | Default |
|-------|---------|---------|
| `print.paperSize` | Paper dimensions | A4 |

## Custom fonts

A theme declares its own web fonts under `fonts.custom`. There is no list of
allowed fonts in the source — adding one is pure configuration:

```json
{
  "fonts": {
    "body": "Example Sans",
    "display": "Example Sans",
    "custom": [
      { "family": "Example Sans", "weight": "100 900", "style": "normal",
        "src": "/fonts/example/ExampleSans-Variable.ttf" },
      { "family": "Example Sans", "weight": "100 900", "style": "italic",
        "src": "/fonts/example/ExampleSans-Italic-Variable.ttf" }
    ]
  }
}
```

| Field | Notes |
|-------|-------|
| `family` | Must match the family named in `fonts.body` / `fonts.display` / `fonts.mono` |
| `src` | Must be `/fonts/<client>/<file>` with a lowercase `.woff2`, `.woff`, `.otf` or `.ttf` extension |
| `weight` | `1`–`1000`, `normal`, `bold`, or a variable range like `"100 1000"` (optional) |
| `style` | `normal` or `italic` (optional) |

Entries that fail validation are dropped silently — if a font isn't applying,
check `src` against the pattern above first. A theme is capped at 12 entries.

`fonts.custom` drives the **web** only. PDF export resolves families through
fontconfig inside the WeasyPrint container, so a font needs to be present in
both places; the workflow below does that in one step.

## Brand assets

Logos, licensed fonts and per-client theme config live in a gitignored
`brand/` directory — the single source of truth for anything that must not be
committed. It reaches the deploy host via `deploy.sh`, which rsyncs the
working tree rather than a git checkout. Fonts are pushed as a separate step
there, and only when the deploying checkout actually has them — a deploy from
a machine without `brand/` leaves the host's fonts untouched instead of
deleting them.

```
brand/
  <client>/
    fonts/*.{woff2,woff,otf,ttf}   font files
    logo.svg                        vector source
    logo.png                        rasterised copy for upload
    theme.json                      theme tokens
```

Builds can't read from `brand/` directly — Astro serves web fonts only from
`packages/web/public/`, and Docker `COPY` can't reach outside the
`infra/weasyprint/` build context — so a script copies fonts into both:

```bash
./scripts/sync-brand-assets.sh
```

Both destinations are gitignored, so licensed binaries stay out of the repo
whichever path is used. Web fonts land at `/fonts/<client>/<file>`, which is
what `src` must point at; print fonts land at `infra/weasyprint/fonts/<client>/`
and are namespaced the same way, so two clients shipping a `Regular.woff2`
don't overwrite each other.

The script is a **mirror**, not an add-only copy. A font removed or renamed
under `brand/` is removed from both destinations on the next run, and so is a
client directory that no longer exists there. Nothing else may write to those
two directories — a file placed there by hand will be pruned. File extensions
are lowercased on the way in, so `Font.OTF` in `brand/` is served as
`Font.otf`; that is the only spelling `src` will accept.

If `brand/` has no fonts at all the script leaves the destinations alone rather
than emptying them, on the grounds that an empty `brand/` is usually a
half-finished setup and not a request to unbrand everything.

PDF fonts are baked into the WeasyPrint image, so adding or changing one needs
an image rebuild:

```bash
DEPLOY_HOST=... ./scripts/deploy.sh --infra
```

### Font licensing

- **Redistributable fonts (OFL and similar)** are fetched at image-build time
  with `wget`, like the built-in families in `infra/weasyprint/Dockerfile`.
  Don't commit binaries into the font directories: they are gitignored, and
  `sync-brand-assets.sh` mirrors `brand/` over them, so anything committed
  there would be both invisible to git and deleted on the next sync.
- **Licensed or proprietary fonts** go in `brand/<client>/fonts/` and are
  never committed. Keep the licence file alongside them.

## Creating a Theme via API

```bash
# Create
curl -X POST /api/themes \
  -H "Authorization: Bearer sk-..." \
  -d '{"name": "My Theme", "tokens": {"fonts": {"display": "Georgia"}}}'

# Upload logo
curl -X POST /api/themes/{id}/logo \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: image/svg+xml" \
  --data-binary @logo.svg

# Assign to space
curl -X PUT /api/spaces/my-space \
  -H "Authorization: Bearer sk-..." \
  -d '{"themeId": "{theme-id}"}'
```

## How Themes Are Applied

**On the web**: Theme tokens are converted to CSS custom properties (`--sw-font-display`, `--sw-accent`, etc.) and injected as a `<style>` block. Custom fonts get `@font-face` rules pointing to hosted font files.

**In PDF**: Theme tokens are converted to CSS custom properties (`--th-font-display`, `--th-color-accent`, etc.) used by the print stylesheet. The logo is embedded as a base64 data URL. Custom fonts are resolved from the WeasyPrint container's font library.
