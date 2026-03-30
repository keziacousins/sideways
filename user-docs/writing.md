# Writing & Editing

## Markdown

Sideways documents are written in standard markdown with GitHub Flavoured Markdown (GFM) extensions.

### Supported Syntax

**Text formatting**: `**bold**`, `*italic*`, `~~strikethrough~~`, `` `inline code` ``

**Headings**: `# H1` through `###### H6`

**Links**: `[text](url)` for external links

**Images**: `![alt](url)`

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

Inline: `$E = mc^2$`

Block:

```markdown
$$
\int_0^\infty e^{-x} dx = 1
$$
```

## Wiki-Links

Link to other documents in the same space using double brackets:

```markdown
See [[api-design]] for details.
```

With custom display text:

```markdown
Read the [[api-design|API Design Guide]] for more.
```

Wiki-links render as dotted-underline links and resolve to the correct URL within the space.

### Autocomplete

When editing in the web editor or writing a comment, type `[[` to trigger autocomplete. A dropdown shows matching documents — use arrow keys and Enter to select.

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
- **Right pane**: live rendered preview
- **Scroll sync**: clicking in the editor scrolls the preview to the corresponding heading
- **Save**: Cmd+S or the Save button
- **Cancel**: Escape or the Cancel button

The editor supports wiki-link autocomplete — type `[[` to insert links to other documents.

## Tags

Tags are shown in the document header. Click the `+` button to add a tag, or the `×` on a tag to remove it. Tags are searchable and visible in document lists.
