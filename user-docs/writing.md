# Writing & Editing

## Markdown

Sideways documents are written in standard markdown with GitHub Flavoured Markdown (GFM) extensions.

### Supported Syntax

**Text formatting**: `**bold**`, `*italic*`, `~~strikethrough~~`, `` `inline code` ``

**Headings**: `# H1` through `###### H6`

**Links**: `[text](url)` for external links

**Images**: `![alt](url)` — a web address, or a file beside the document (see [Images and Files](#images-and-files))

**Lists**: unordered (`-`), ordered (`1.`), and task lists (`- [x]`)

**Tables**:

```markdown
| Column A | Column B |
|----------|----------|
| Cell 1   | Cell 2   |
```

**Code blocks** with syntax highlighting:

````markdown
```python
def hello():
    print("Hello from Sideways")
```
````

**Blockquotes**:

```markdown
> This is a blockquote
```

**Math** (KaTeX):

Inline: `$$E = mc^2$$`

Block:

```markdown
$$
\int_0^\infty e^{-x} dx = 1
$$
```

Single-`$` is reserved for currency in prose (e.g. `$2k budget`) — it won't trigger math parsing. Wrap math in `$$...$$` whether inline or block.

## Wiki-Links

Link to other documents in the same space using double brackets. Three forms, in increasing specificity:

**Bare basename** — link by the doc's filename (without `.md`):

```markdown
See [[overview]] for details.
```

The renderer looks for a doc named `overview.md`, preferring (in order):

1. same directory as the linking doc,
2. same section (any directory) — uses the unique basename if there's only one,
3. a section slug whose section has an `index.md` (so `[[architecture]]` resolves to `architecture/index.md`),
4. space-wide — uses the unique basename across the whole space.

If exactly one matches, it links. Ambiguous matches (several `overview.md` files at the same precedence layer) render as marked-but-unresolved.

**Path-qualified** — section-relative path, no `.md`:

```markdown
See [[architecture/overview]] for details.
```

Always resolves within the linking doc's section. Use this when basename alone would be ambiguous.

**Relative** — anchored to the linking doc's directory, like a filesystem path:

```markdown
See [[./auth]] (a sibling) and [[../guides/intro]] (up-and-over) for details.
```

The most refactor-resilient form: relative links survive directory renames at the section root.

**Custom display text** works with any of the above:

```markdown
Read the [[architecture/overview|API Design Guide]] for more.
```

Display labels are **plain text only** — markdown formatting (`` `code` ``, `**bold**`, `*italic*`, nested links) inside the display half of a wikilink is not supported. Backticks, in particular, will open an inline code span that splits the wikilink across AST nodes and the link silently fails to render. If you need a code-styled label, render it outside the link: `` the [[architecture/overview|overview]] (`MyClass`) ``.

Resolved wiki-links render as dotted-underline links to the canonical doc URL. **Unresolved** wiki-links (target doesn't exist) render as a wavy red underline. **Ambiguous** wiki-links (multiple basename matches) render as a wavy amber underline.

### Autocomplete

When editing in the web editor or writing a comment, type `[[` to trigger autocomplete. A dropdown shows matching documents — use arrow keys and Enter to select. The picker inserts the path-qualified form by default (e.g. `[[architecture/overview|Title]]`).

## Images and Files

Sideways hosts images and PDFs alongside your documents. Keep the file next to the markdown and reference it with an ordinary relative link:

```markdown
![Login flow](./img/flow.png)

The full detail is in the [protocol spec](./spec.pdf).
```

The path is relative to the document, exactly as it is on disk — so the same markdown also renders on GitHub and in a local editor. From `guides/auth.md`, `./img/flow.png` is the file `guides/img/flow.png` in the same section. `../` climbs a directory, but a reference can't leave the section.

| Type | On the web | In a PDF export |
|------|------------|-----------------|
| PNG, JPEG, GIF, WebP, SVG | Shown inline | Embedded (an animated GIF prints its first frame) |
| PDF | A link that opens in a new tab | A link to the hosted file — never embedded |

Images can be up to 10 MB and PDFs up to 20 MB. Images always scale to the width of the page; there is no syntax for sizing them.

**File names** may contain only letters, digits, `.`, `_` and `-`, the same as document paths. A file called `my diagram.png` has to be renamed before it can be uploaded.

**Getting files onto Sideways:**

- **CLI** — `sideways push` uploads every image and PDF your tracked documents reference. See the [[cli-guide|CLI Guide]].
- **Web editor** — paste or drop a file onto the editor (see [Web Editor](#web-editor)).

A file is stored once per path and replaced in place, so there is no version history: an older version of a document shows the current image. Anyone who can read the space can open its files; nobody else can.

Images from elsewhere on the web still work with a full `https://` address.

## Frontmatter

Documents can include YAML frontmatter for metadata:

```markdown
---
title: My Custom Title
tags: [api, architecture, v2]
---

# Document Content

...
```

- **title** — overrides the title extracted from the first `# heading`
- **tags** — categorisation tags, shown in the document header and searchable

If no frontmatter title is set, Sideways extracts the title from the first `# heading` in the document.

## Web Editor

Click the edit icon in the document toolbar to open the side-by-side editor:

- **Left pane**: markdown textarea with monospace font
- **Right pane**: live rendered preview (debounced as you type)
- **Scroll sync**: clicking or moving the cursor in the editor scrolls the preview to the nearest heading above the cursor
- **Attach a file**: paste an image from the clipboard, or drop an image or PDF onto the editor. It is uploaded into an `assets/` folder beside the document and a reference is inserted at the cursor. A file whose name is already taken by a different file is stored as `name-2`, `name-3`, and so on
- **Save**: click the Save button
- **Cancel**: click the Cancel button

The editor supports wiki-link autocomplete — type `[[` to insert links to other documents.

## Tags

Tags are shown in the document header. Click the `+` button to add a tag, or the `×` on a tag to remove it. Tags are searchable and visible in document lists.
