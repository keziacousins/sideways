# Search

Sideways provides full-text search across all documents you have access to.

## Web Search

Press **⌘K** (Mac) or **Ctrl+K** (Windows/Linux) to open the search modal, or click the search bar in the header.

Type to search — results appear as you type with highlighted matches. Use arrow keys to navigate, Enter to open a result, Escape to close.

Search matches against document **titles** (highest priority), **tags**, and **content**.

## CLI Search

```bash
sideways search "api design"
```

Options:
- `--space <slug>` — limit to a specific space
- `--limit <n>` — max results (default 10)

## MCP Search

The `search` tool provides full-text search for AI agents:

```
search(query="api design", space="engineering")
```

Returns ranked results with text snippets (HTML tags stripped for plain text output).

## How It Works

Sideways uses Postgres full-text search with weighted ranking:

- **Title matches** rank highest (weight A)
- **Tag matches** rank second (weight B)
- **Content matches** rank third (weight C)

Results include snippets with matching terms highlighted. The search supports prefix matching on the last word for responsive as-you-type results.

## Visibility

Search respects space permissions. You'll only see results from:

- **Public** spaces (everyone)
- **Org** spaces (any authenticated user)
- **Private/shared** spaces where you're the owner or a member
