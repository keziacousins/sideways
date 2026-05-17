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

Custom fonts must be installed on the server (in the WeasyPrint container for PDF, and served as web fonts for the browser).

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
| `logo` | URL to logo image (uploaded via theme API) |

### Print

| Token | Affects | Default |
|-------|---------|---------|
| `print.paperSize` | Paper dimensions | A4 |

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
